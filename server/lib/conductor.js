/**
 * @file Durable Claude-to-Codex direction, turn queues, approvals and bounded polling.
 * Spawners and persistence are injectable so tests never launch real agents.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { leadPrompt, collaboratorPrompt } = require("./conductor-prompts");
const now = () => new Date().toISOString();
const terminal = new Set(["error", "stopped"]);
function problem(message, status = 400) {
  return Object.assign(new Error(message), {
    status,
    code: status === 404 ? "ENOTFOUND" : "ECONDUCTOR",
  });
}
function required(value, name, max = 50000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw problem(`${name} must be a non-empty string (max ${max})`);
  return value.trim();
}
function codexApprovalSummary({ method, params = {} }) {
  const short = (value, max = 350) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .slice(0, max);
  if (method === "item/commandExecution/requestApproval") {
    return `Ejecutar: ${short(params.command) || "comando"}${params.reason ? ` — ${short(params.reason, 150)}` : ""}`;
  }
  const changes = params.changes || params.fileChanges || params.files || [];
  const paths = Array.isArray(changes)
    ? changes
        .map((entry) => (typeof entry === "string" ? entry : entry.path || entry.filePath))
        .filter(Boolean)
    : Object.keys(changes);
  return `Cambiar archivos: ${short(paths.join(", ") || params.path || params.grantRoot) || "rutas no indicadas"}`;
}
function createConductor({
  db = require("../db").db,
  claude = require("./run-spawner"),
  codex = require("./codex-run-spawner"),
  broadcast = require("../websocket").broadcast,
  saveHandoff = require("./codex-handoffs").saveHandoff,
  configRoot = os.tmpdir(),
  timeoutMs = 30 * 60 * 1000,
  reconcileMs = 2000,
} = {}) {
  const active = new Map();
  const decisions = new Map();
  const timers = new Map();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const get = (table, id) => db.prepare(`SELECT * FROM conductor_${table} WHERE id = ?`).get(id);
  function need(table, id) {
    const row = get(table, id);
    if (!row) throw problem(`${table} not found`, 404);
    return row;
  }
  function insert(table, row) {
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO conductor_${table} (${keys.join(",")}) VALUES (${keys.map((k) => "@" + k).join(",")})`
    ).run(row);
    return row;
  }
  function patch(table, id, values) {
    db.prepare(
      `UPDATE conductor_${table} SET ${Object.keys(values)
        .map((k) => `${k} = @${k}`)
        .join(",")} WHERE id = @id`
    ).run({ ...values, id });
    return need(table, id);
  }
  function publicRow(table, row) {
    if (table === "rounds") {
      const { from_agent, to_agent, ...rest } = row;
      return { ...rest, from: from_agent, to: to_agent };
    }
    if (table === "approvals")
      return { ...row, options: row.options ? JSON.parse(row.options) : null };
    return row;
  }
  function publish(table, row) {
    broadcast(
      `conductor_${{ orders: "order", rounds: "round", approvals: "approval" }[table]}`,
      publicRow(table, row)
    );
    events.emit(`${table}:${row.id}`);
    return row;
  }
  function rows(table, id) {
    return db
      .prepare(
        `SELECT * FROM conductor_${table} WHERE order_id = ? ORDER BY ${table === "rounds" ? "n" : "created_at"}`
      )
      .all(id);
  }
  function state(id, status) {
    const order = need("orders", id);
    if (terminal.has(order.status)) return order;
    return publish(
      "orders",
      patch("orders", id, {
        status,
        ended_at: ["done", "error", "stopped"].includes(status) ? now() : null,
      })
    );
  }
  function refresh(id) {
    if (rows("approvals", id).some((a) => a.status === "pending")) return state(id, "waiting_ok");
    if (rows("rounds", id).some((r) => r.status === "pending")) return state(id, "delegating");
    return state(id, active.get(id)?.busy ? "planning" : "done");
  }
  function clearDeadline(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  function deadline(id, action) {
    clearDeadline(id);
    const timer = setTimeout(() => {
      timers.delete(id);
      action();
    }, timeoutMs);
    timer.unref?.();
    timers.set(id, timer);
  }
  function cleanup(runtime) {
    if (runtime?.config) {
      try {
        fs.unlinkSync(runtime.config);
      } catch {
        /* already removed */
      }
      try {
        fs.rmdirSync(path.dirname(runtime.config));
      } catch {
        /* non-empty is preserved */
      }
      runtime.config = null;
    }
  }
  function finish(id, status, reason) {
    const runtime = active.get(id);
    if (runtime) runtime.busy = false;
    state(id, status);
    for (const round of rows("rounds", id).filter((r) => r.status === "pending")) {
      clearDeadline(round.id);
      publish(
        "rounds",
        patch("rounds", round.id, { status: "error", reply: reason, reply_at: now() })
      );
    }
    for (const approval of rows("approvals", id).filter((a) => a.status === "pending")) {
      answerApproval(approval.id, { answer: "stop", note: reason }, false);
    }
    if (runtime) {
      runtime.queue.length = 0;
      if (runtime.lead) claude.killRun(runtime.lead.id);
      if (runtime.worker) codex.killRun(runtime.worker.id);
      cleanup(runtime);
      active.delete(id);
    }
    reconcile();
    return getOrder(id);
  }
  function resolveOrder(input) {
    if (input.orderId) {
      const order = need("orders", required(input.orderId, "orderId"));
      if (!active.has(order.id) || terminal.has(order.status))
        throw problem("order is not active", 409);
      return order;
    }
    const candidates = [...active.keys()].filter((id) => {
      const runtime = active.get(id);
      const order = get("orders", id);
      if (terminal.has(order.status)) return false;
      if (input.leadSessionId) return runtime.lead?.sessionId === input.leadSessionId;
      return input.cwd && runtime.project.cwd === input.cwd;
    });
    if (candidates.length !== 1)
      throw problem("provide orderId or an unambiguous leadSessionId/cwd", 409);
    return need("orders", candidates[0]);
  }
  function agent(id, who, envelope, handle) {
    const runtime = active.get(id);
    if (!runtime) return;
    const content = envelope.message?.content;
    const tool = Array.isArray(content) && content.find((b) => b.type === "tool_use");
    const item = envelope.params?.item;
    const usage = envelope.usage || envelope.message?.usage || envelope.params?.tokenUsage;
    const previous = runtime.agents[who] || {};
    const value = {
      orderId: id,
      agent: who,
      runId: handle.id,
      sessionId: handle.sessionId || null,
      doing: String(
        tool?.name ||
          (item && !["agentMessage", "agent_message", "final_answer"].includes(item.type)
            ? item.type
            : "pensando")
      ).slice(0, 100),
      model: handle.model || null,
      effort: handle.effort || null,
      tokens: usage || previous.tokens || null,
    };
    runtime.agents[who] = value;
    broadcast("conductor_agent", value);
  }
  async function dispatch(id) {
    const runtime = active.get(id);
    if (!runtime || runtime.busy || !runtime.queue.length) return;
    const text = runtime.queue.shift();
    runtime.busy = true;
    state(id, "planning");
    try {
      await claude.sendInput(runtime.lead.id, text);
    } catch (err) {
      finish(id, "error", err.message);
    }
  }
  function leadEvent(id, envelope, handle) {
    const runtime = active.get(id);
    if (!runtime) return;
    runtime.lead = handle;
    agent(id, "claude", envelope, handle);
    if (envelope.type === "system" && envelope.subtype === "init") reconcile();
    if (envelope.type === "assistant" && Array.isArray(envelope.message?.content)) {
      const text = envelope.message.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) runtime.lastText = text;
    }
    if (envelope.type !== "result") return;
    runtime.busy = false;
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== "success")) {
      finish(id, "error", envelope.result || "Claude turn failed");
      return;
    }
    if (typeof envelope.result === "string" && envelope.result.trim())
      publish("orders", patch("orders", id, { result: envelope.result.trim().slice(0, 8000) }));
    if (runtime.queue.length) void dispatch(id);
    else refresh(id);
  }
  function workerEvent(id, envelope, handle) {
    const runtime = active.get(id);
    if (!runtime) return;
    runtime.worker = handle;
    agent(id, "codex", envelope, handle);
    const round = runtime.round && get("rounds", runtime.round);
    if (!round || round.status !== "pending") return;
    const item = envelope.params?.item;
    if (
      envelope.method?.startsWith("item/") &&
      item &&
      ["agentMessage", "agent_message", "final_answer"].includes(item.type)
    ) {
      const text = item.text || item.message || item.content;
      if (typeof text === "string") runtime.reply = text;
      else if (Array.isArray(text)) runtime.reply = text.map((p) => p.text || "").join("\n");
    }
    if (envelope.method !== "turn/completed") return;
    const turn = envelope.params?.turn;
    if (turn?.error || ["failed", "interrupted"].includes(turn?.status)) {
      finish(id, "error", turn?.error?.message || "Codex turn failed");
      return;
    }
    clearDeadline(round.id);
    const reply =
      runtime.reply.length > 8000
        ? runtime.reply.slice(0, 7900) + "\n[Respuesta recortada; el detalle está en la sesión.]"
        : runtime.reply;
    publish("rounds", patch("rounds", round.id, { status: "done", reply, reply_at: now() }));
    runtime.round = null;
    reconcile();
    refresh(id);
  }
  function onStatus(id, who, status) {
    if (!active.has(id)) return;
    if (["error", "killed", "completed"].includes(status)) {
      const order = get("orders", id);
      // An idle collaborator may exit or be reaped; the next round starts a new run.
      if (
        who === "codex" &&
        !rows("rounds", id).some((r) => r.status === "pending") &&
        !rows("approvals", id).some((a) => a.agent === "codex" && a.status === "pending")
      )
        return;
      if (who === "claude" && order.status === "done" && status === "completed") {
        const runtime = active.get(id);
        active.delete(id);
        if (runtime.worker) codex.killRun(runtime.worker.id);
        cleanup(runtime);
      } else if (!terminal.has(order.status)) finish(id, "error", `${who} run ended (${status})`);
    }
  }
  function createOrder({ projectId, text }, baseUrl) {
    const project = need("projects", required(projectId, "projectId"));
    text = required(text, "text");
    if (project.lead !== "claude") throw problem("Phase 1 only supports claude as lead");
    if (!fs.statSync(project.cwd).isDirectory()) throw problem("cwd must be an existing directory");
    // One lead per project: a working order blocks new ones; a finished order whose lead
    // still idles for indications is retired so its processes do not linger.
    for (const [id, runtime] of active) {
      if (runtime.project.id !== project.id) continue;
      if (get("orders", id).status !== "done")
        throw problem("this project already has an order in progress", 409);
      finish(id, "done", "Replaced by a new order");
    }
    const order = insert("orders", {
      id: randomUUID(),
      project_id: project.id,
      text,
      status: "planning",
      lead_run_id: null,
      created_at: now(),
      ended_at: null,
    });
    const runtime = { project, queue: [], busy: true, agents: {}, reply: "" };
    active.set(order.id, runtime);
    try {
      const dir = fs.mkdtempSync(path.join(configRoot, "ccam-conductor-"));
      runtime.config = path.join(dir, "mcp.json");
      const env = {
        CONDUCTOR_ORDER_ID: order.id,
        MCP_DASHBOARD_ALLOW_MUTATIONS: "true",
        MCP_DASHBOARD_TIMEOUT_MS: "120000",
        MCP_DASHBOARD_BASE_URL: baseUrl || `http://127.0.0.1:${process.env.DASHBOARD_PORT || 4820}`,
      };
      fs.writeFileSync(
        runtime.config,
        JSON.stringify({
          mcpServers: {
            ccam: {
              command: process.execPath,
              args: [path.resolve(__dirname, "../../mcp/build/index.js")],
              env,
            },
          },
        }),
        { mode: 0o600 }
      );
      runtime.lead = claude.spawnRun({
        prompt: leadPrompt(text),
        mode: "conversation",
        cwd: project.cwd,
        model: project.claude_model,
        effort: project.claude_effort,
        permissionMode: "acceptEdits",
        mcpConfig: runtime.config,
        allowedTools: [
          "mcp__ccam__dashboard_handoff",
          "mcp__ccam__dashboard_ask_user",
          "mcp__ccam__dashboard_permission",
        ],
        permissionPromptTool: "mcp__ccam__dashboard_permission",
        env: { ...env, MCP_TOOL_TIMEOUT: String(35 * 60 * 1000) },
        onEnvelope: (e, h) => leadEvent(order.id, e, h),
        onStatus: (s) => onStatus(order.id, "claude", s),
      });
      publish("orders", patch("orders", order.id, { lead_run_id: runtime.lead.id }));
    } catch (err) {
      finish(order.id, "error", err.message);
      throw err;
    }
    return getOrder(order.id);
  }
  function indication(id, text) {
    required(text, "text");
    const order = resolveOrder({ orderId: id });
    const runtime = active.get(order.id);
    if (runtime.queue.length >= 100) throw problem("indication queue is full", 429);
    const queued = runtime.busy;
    runtime.queue.push(text);
    void dispatch(id);
    return { queued };
  }
  function handoff(input) {
    const order = resolveOrder(input);
    if (input.to !== "codex") throw problem("Phase 1 handoffs must target codex");
    const ask = required(input.ask, "ask");
    const runtime = active.get(order.id);
    if (rows("rounds", order.id).some((r) => r.status === "pending"))
      throw problem("a handoff is already pending", 409);
    // The lead's text right before its first handoff is the plan Martin sees in the score.
    if (!order.plan && runtime.lastText)
      publish("orders", patch("orders", order.id, { plan: runtime.lastText.slice(0, 4000) }));
    const round = insert("rounds", {
      id: randomUUID(),
      order_id: order.id,
      n: rows("rounds", order.id).length + 1,
      from_agent: "claude",
      to_agent: "codex",
      ask,
      ask_at: now(),
      reply: null,
      reply_at: null,
      run_id: null,
      status: "pending",
    });
    runtime.round = round.id;
    runtime.reply = "";
    const project = runtime.project;
    try {
      if (
        runtime.worker &&
        ["running", "spawning"].includes(codex.getRun(runtime.worker.id)?.status)
      ) {
        patch("rounds", round.id, { run_id: runtime.worker.id });
        Promise.resolve(codex.sendInput(runtime.worker.id, collaboratorPrompt(ask))).catch((err) =>
          finish(order.id, "error", err.message)
        );
      } else {
        runtime.worker = codex.spawnRun({
          prompt: collaboratorPrompt(ask),
          cwd: project.cwd,
          model: project.codex_model,
          effort: project.codex_effort,
          sandbox: project.codex_sandbox,
          permissionMode: "on-request",
          onEnvelope: (e, h) => workerEvent(order.id, e, h),
          onStatus: (s) => onStatus(order.id, "codex", s),
          onRequest: (message, server) => {
            if (
              ![
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
              ].includes(message.method)
            )
              return false;
            const approval = createApproval({
              orderId: order.id,
              agent: "codex",
              kind: "permission",
              summary: codexApprovalSummary(message),
              detail: JSON.stringify(message.params || {}).slice(0, 50000),
            });
            decisions.set(approval.approvalId, (answer) =>
              server.respond(message.id, { decision: answer === "approve" ? "accept" : "decline" })
            );
            return true;
          },
        });
        patch("rounds", round.id, { run_id: runtime.worker.id });
      }
      deadline(round.id, () => finish(order.id, "error", "Handoff timed out"));
      publish("rounds", need("rounds", round.id));
      refresh(order.id);
      reconcile();
    } catch (err) {
      finish(order.id, "error", err.message);
    }
    return { roundId: round.id };
  }
  function createApproval(input) {
    const order = resolveOrder(input);
    if (!["claude", "codex"].includes(input.agent)) throw problem("agent must be claude or codex");
    if (!["permission", "question"].includes(input.kind))
      throw problem("kind must be permission or question");
    const summary = required(input.summary, "summary", 4000);
    if (input.detail != null && (typeof input.detail !== "string" || input.detail.length > 50000))
      throw problem("detail must be a string (max 50000)");
    if (
      input.options != null &&
      (!Array.isArray(input.options) ||
        input.options.length > 20 ||
        input.options.some((o) => typeof o !== "string" || o.length > 2000))
    )
      throw problem("options must be an array of up to 20 strings");
    const approval = insert("approvals", {
      id: randomUUID(),
      order_id: order.id,
      agent: input.agent,
      kind: input.kind,
      summary,
      detail: input.detail || null,
      options: input.options ? JSON.stringify(input.options) : null,
      status: "pending",
      created_at: now(),
      answered_at: null,
      answer: null,
      note: null,
    });
    publish("approvals", approval);
    refresh(order.id);
    deadline(approval.id, () => finish(order.id, "error", "Approval timed out"));
    return { approvalId: approval.id };
  }
  function answerApproval(id, { answer, note }, stop = true) {
    if (!["approve", "change", "stop"].includes(answer))
      throw problem("answer must be approve, change or stop");
    if (note != null && (typeof note !== "string" || note.length > 50000))
      throw problem("note must be a string (max 50000)");
    const approval = need("approvals", id);
    if (approval.status !== "pending") {
      if (approval.answer === answer && (approval.note || "") === (note || ""))
        return publicRow("approvals", approval);
      throw problem("approval is already answered", 409);
    }
    clearDeadline(id);
    const updated = patch("approvals", id, {
      answer,
      note: note || null,
      status: "answered",
      answered_at: now(),
    });
    const respond = decisions.get(id);
    decisions.delete(id);
    try {
      respond?.(answer);
    } catch {
      /* process may already have exited */
    }
    publish("approvals", updated);
    if (answer === "stop" && stop)
      finish(approval.order_id, "stopped", note || "Stopped by Martin");
    else refresh(approval.order_id);
    return publicRow("approvals", updated);
  }
  function getOrder(id) {
    const order = need("orders", id);
    const runtime = active.get(id);
    const rounds = rows("rounds", id);
    const persisted = (runId) =>
      runId ? db.prepare("SELECT * FROM dashboard_runs WHERE id = ?").get(runId) || null : null;
    return {
      ...order,
      rounds: rounds.map((r) => publicRow("rounds", r)),
      approvals: rows("approvals", id).map((a) => publicRow("approvals", a)),
      runs: {
        claude: claude.getRun(order.lead_run_id) || persisted(order.lead_run_id),
        codex: runtime?.worker ? codex.getRun(runtime.worker.id) : persisted(rounds.at(-1)?.run_id),
      },
      agents: runtime?.agents || {},
    };
  }
  function poll(table, id, waitMs = 0, signal) {
    if (!["rounds", "approvals"].includes(table)) throw problem("invalid poll resource");
    const duration = Number(waitMs);
    if (!Number.isFinite(duration) || duration < 0 || duration > 100000)
      throw problem("waitMs must be between 0 and 100000");
    const read = () => {
      const row = need(table, id);
      return table === "rounds"
        ? { status: row.status, reply: row.reply }
        : { status: row.status, answer: row.answer, note: row.note };
    };
    const initial = read();
    if (initial.status !== "pending" || !duration || signal?.aborted)
      return Promise.resolve(initial);
    return new Promise((resolve) => {
      const key = `${table}:${id}`;
      const done = () => {
        clearTimeout(timer);
        events.removeListener(key, done);
        signal?.removeEventListener("abort", done);
        resolve(read());
      };
      const timer = setTimeout(done, duration);
      events.on(key, done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  // Persisted run/session mappings let reconciliation survive both ingestion lag and restart.
  function reconcile() {
    const groups = db
      .prepare(
        `SELECT DISTINCT r.order_id, r.run_id, o.lead_run_id FROM conductor_rounds r JOIN conductor_orders o ON o.id = r.order_id WHERE r.run_id IS NOT NULL`
      )
      .all();
    for (const group of groups) {
      const runtime = active.get(group.order_id);
      const sessionFor = (runId, handle) =>
        (handle?.id === runId && handle.sessionId) ||
        db.prepare("SELECT session_id FROM dashboard_runs WHERE id = ?").get(runId)?.session_id;
      const sessionId = sessionFor(group.run_id, runtime?.worker);
      const parent = sessionFor(group.lead_run_id, runtime?.lead);
      if (
        !sessionId ||
        !parent ||
        !db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId)
      )
        continue;
      const rounds = rows("rounds", group.order_id)
        .filter((r) => r.run_id === group.run_id)
        .map(({ ask, ask_at, reply, reply_at }) => ({ ask, ask_at, reply, reply_at }));
      if (
        saveHandoff(sessionId, { from: "claude", parent_session_id: parent, rounds }, "conductor")
      ) {
        broadcast(
          "session_updated",
          db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId)
        );
      }
    }
  }
  // Processes cannot be reattached after a dashboard restart; never leave polls pending forever.
  for (const order of db
    .prepare("SELECT id FROM conductor_orders WHERE status NOT IN ('done', 'error', 'stopped')")
    .all())
    finish(order.id, "error", "Dashboard restarted");
  const reconcileTimer = reconcileMs > 0 ? setInterval(reconcile, reconcileMs) : null;
  reconcileTimer?.unref?.();
  function close() {
    for (const id of [...active.keys()]) finish(id, "stopped", "Conductor closed");
    clearInterval(reconcileTimer);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }
  return {
    createOrder,
    indication,
    handoff,
    createApproval,
    answerApproval,
    getOrder,
    poll,
    reconcile,
    close,
    stop: (id) => {
      need("orders", id);
      return finish(id, "stopped", "Stopped by Martin");
    },
    listProjects: () =>
      db.prepare("SELECT * FROM conductor_projects ORDER BY created_at DESC").all(),
    listOrders: (projectId, limit = 20) => {
      need("projects", required(projectId, "projectId"));
      const count = Number(limit);
      if (!Number.isInteger(count) || count < 1 || count > 100)
        throw problem("limit must be an integer between 1 and 100");
      return db
        .prepare(
          "SELECT * FROM conductor_orders WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
        )
        .all(projectId, count);
    },
    insertProject: (project) =>
      insert("projects", { id: randomUUID(), ...project, created_at: now() }),
  };
}
let singleton;
function getConductor() {
  return (singleton ||= createConductor());
}
module.exports = { createConductor, getConductor, required, problem };
