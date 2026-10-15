/**
 * @file Conductor integration tests with simulated agents, real SQLite and HTTP.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const TMP = fs.mkdtempSync(path.join(__dirname, ".conductor-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "test.db");
const { db, migrateConductor } = require("../db");
const { createConductor } = require("../lib/conductor");
const { CodexAppServer } = require("../lib/codex-app-server");
const { saveHandoff, reconcileHandoffParents } = require("../lib/codex-handoffs");
let conductor, claude, codex, messages;
function fake(provider) {
  const handles = new Map();
  return {
    handles,
    inputs: [],
    spawnRun(args) {
      const id = `${provider}-${handles.size}`;
      const handle = { ...args, id, sessionId: `${id}-session`, status: "running", args };
      handles.set(id, handle);
      return handle;
    },
    getRun(id) {
      const h = handles.get(id);
      return h ? { id, status: h.status, sessionId: h.sessionId } : null;
    },
    killRun(id) {
      const h = handles.get(id);
      if (h) h.status = "killed";
      return !!h;
    },
    sendInput(id, text) {
      this.inputs.push({ id, text });
    },
    emit(envelope) {
      const h = [...handles.values()].at(-1);
      h.args.onEnvelope(envelope, h);
    },
  };
}
function setup(options = {}) {
  claude = fake("claude");
  codex = fake("codex");
  messages = [];
  conductor = createConductor({
    db,
    claude,
    codex,
    saveHandoff,
    configRoot: TMP,
    reconcileMs: 0,
    broadcast: (type, data) => messages.push({ type, data }),
    ...options,
  });
  const project = conductor.insertProject({
    cwd: TMP,
    name: "Test",
    lead: "claude",
    claude_model: "sonnet",
    claude_effort: "high",
    codex_model: "test-model",
    codex_effort: "high",
    codex_sandbox: "workspace-write",
  });
  return conductor.createOrder(
    { projectId: project.id, text: "Implementa el cambio" },
    "http://127.0.0.1:4820"
  );
}
beforeEach(() => {
  conductor?.close();
  for (const table of ["approvals", "rounds", "orders", "projects"])
    db.exec(`DELETE FROM conductor_${table}`);
  db.exec("DELETE FROM sessions");
});
after(() => {
  conductor?.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("migration is repeatable and keeps existing rows and indexed SQL-safe columns", () => {
  const order = setup();
  migrateConductor(db);
  migrateConductor(db);
  assert.equal(conductor.getOrder(order.id).text, "Implementa el cambio");
  assert.ok(
    db
      .prepare("PRAGMA table_info(conductor_rounds)")
      .all()
      .some((c) => c.name === "from_agent")
  );
  assert.ok(
    db
      .prepare("PRAGMA index_list(conductor_approvals)")
      .all()
      .some((i) => i.name === "idx_conductor_approvals_order")
  );
});
test("lead configuration, complete handoff, reuse, clipping and late session metadata", async () => {
  const order = setup();
  const lead = [...claude.handles.values()][0];
  const config = JSON.parse(fs.readFileSync(lead.mcpConfig));
  assert.equal(config.mcpServers.ccam.command, process.execPath);
  assert.equal(config.mcpServers.ccam.args[0], path.resolve(__dirname, "../../mcp/build/index.js"));
  assert.deepEqual(lead.allowedTools, [
    "mcp__ccam__dashboard_handoff",
    "mcp__ccam__dashboard_ask_user",
    "mcp__ccam__dashboard_permission",
  ]);
  assert.equal(lead.permissionPromptTool, "mcp__ccam__dashboard_permission");
  assert.equal(config.mcpServers.ccam.env.MCP_DASHBOARD_BASE_URL, "http://127.0.0.1:4820");
  assert.equal(lead.permissionMode, "acceptEdits");
  assert.ok(Number(lead.env.MCP_TOOL_TIMEOUT) >= 35 * 60000);
  assert.equal(lead.env.CONDUCTOR_ORDER_ID, order.id);
  const { roundId } = conductor.handoff({
    leadSessionId: lead.sessionId,
    to: "codex",
    ask: "Corrige el bug",
  });
  assert.equal(conductor.getOrder(order.id).status, "delegating");
  const worker = [...codex.handles.values()][0];
  assert.equal(worker.cwd, TMP);
  assert.equal(worker.permissionMode, "on-request");
  const pending = conductor.poll("rounds", roundId, 1000);
  codex.emit({
    method: "item/completed",
    params: { item: { type: "agentMessage", text: "Corregido" } },
  });
  codex.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
  assert.deepEqual(await pending, { status: "done", reply: "Corregido" });
  assert.equal(conductor.getOrder(order.id).rounds[0].from, "claude");
  db.prepare("INSERT INTO sessions (id, provider) VALUES (?, 'codex')").run(worker.sessionId);
  conductor.reconcile();
  let metadata = JSON.parse(
    db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(worker.sessionId).metadata
  );
  assert.equal(metadata.handoff.parent_session_id, lead.sessionId);
  assert.equal(metadata.handoff_parent_evidence, "conductor");
  assert.equal(metadata.handoff.rounds[0].reply, "Corregido");
  assert.equal(
    saveHandoff(
      worker.sessionId,
      { from: "claude", parent_session_id: "wrong", rounds: [] },
      "cwd"
    ),
    false
  );
  assert.equal(
    JSON.parse(
      db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(worker.sessionId).metadata
    ).handoff.parent_session_id,
    lead.sessionId
  );
  const second = conductor.handoff({ orderId: order.id, to: "codex", ask: "Añade test" });
  assert.equal(codex.handles.size, 1);
  assert.equal(codex.inputs.length, 1);
  codex.emit({
    method: "item/completed",
    params: { item: { type: "final_answer", text: "x".repeat(9000) } },
  });
  codex.emit({ method: "turn/completed", params: {} });
  const result = await conductor.poll("rounds", second.roundId);
  assert.ok(result.reply.length < 8000);
  assert.match(result.reply, /detalle está en la sesión/);
  claude.emit({ type: "result", subtype: "success" });
  assert.equal(conductor.getOrder(order.id).status, "done");
  assert.ok(messages.some((m) => m.type === "conductor_agent"));
});
test("indications wait for result and preserve order across turns", () => {
  const order = setup();
  conductor.indication(order.id, "uno");
  conductor.indication(order.id, "dos");
  claude.emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } });
  assert.equal(claude.inputs.length, 0);
  claude.emit({ type: "result", subtype: "success" });
  assert.deepEqual(
    claude.inputs.map((i) => i.text),
    ["uno"]
  );
  claude.emit({ type: "result", subtype: "success" });
  assert.deepEqual(
    claude.inputs.map((i) => i.text),
    ["uno", "dos"]
  );
});
test("Codex server requests are distinct from colliding response ids; decisions reach respond", async () => {
  const order = setup();
  conductor.handoff({ orderId: order.id, to: "codex", ask: "Edita" });
  const worker = [...codex.handles.values()][0];
  const rpc = new EventEmitter();
  Object.setPrototypeOf(rpc, CodexAppServer.prototype);
  rpc.buffer = "";
  rpc.stderr = "";
  rpc.pending = new Map([
    [
      7,
      {
        resolve() {
          throw Error("wrong response");
        },
      },
    ],
  ]);
  rpc.child = { stdin: new PassThrough() };
  let written = "";
  rpc.child.stdin.on("data", (data) => (written += data));
  rpc.on("request", (message) => worker.args.onRequest(message, rpc));
  rpc.consume(
    JSON.stringify({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", reason: "Revisar cambios" },
    }) + "\n"
  );
  const approval = conductor.getOrder(order.id).approvals[0];
  assert.equal(approval.summary, "Ejecutar: git status — Revisar cambios");
  assert.equal(approval.kind, "permission");
  assert.equal(approval.agent, "codex");
  assert.equal(conductor.getOrder(order.id).status, "waiting_ok");
  const waiting = conductor.poll("approvals", approval.id, 1000);
  conductor.answerApproval(approval.id, { answer: "approve", note: "OK" });
  assert.equal((await waiting).answer, "approve");
  assert.deepEqual(JSON.parse(written), { id: 7, result: { decision: "accept" } });
  assert.ok(rpc.pending.has(7));
  written = "";
  rpc.consume(
    JSON.stringify({ id: "stop", method: "item/fileChange/requestApproval", params: {} }) + "\n"
  );
  const second = conductor.getOrder(order.id).approvals.at(-1);
  conductor.answerApproval(second.id, { answer: "stop" });
  assert.deepEqual(JSON.parse(written), { id: "stop", result: { decision: "decline" } });
  assert.equal(conductor.getOrder(order.id).status, "stopped");
});
test("poll timeout, cancellation, missing IDs and stopped rounds settle", async () => {
  const order = setup();
  const { roundId } = conductor.handoff({ orderId: order.id, to: "codex", ask: "Espera" });
  assert.deepEqual(await conductor.poll("rounds", roundId, 10), { status: "pending", reply: null });
  assert.throws(() => conductor.poll("rounds", roundId, 120000), /waitMs/);
  assert.throws(() => conductor.poll("rounds", "missing"), /not found/);
  const abort = new AbortController();
  const pending = conductor.poll("rounds", roundId, 100000, abort.signal);
  abort.abort();
  assert.equal((await pending).status, "pending");
  const waiting = conductor.poll("rounds", roundId, 1000);
  conductor.stop(order.id);
  assert.equal((await waiting).status, "error");
});
test("browse roots list existing Windows drives only", () => {
  const { browseRoots } = require("../routes/conductor").__browse;
  const roots = browseRoots({ platform: "win32", exists: (d) => d === "C:\\" || d === "D:\\" });
  assert.deepEqual(
    roots.map((r) => r.path),
    ["C:\\", "D:\\"]
  );
  assert.deepEqual(browseRoots({ platform: "linux" }), [{ name: "/", path: "/" }]);
});
test("routes enforce origin, cwd, phase-one lead and model validation before side effects", async () => {
  setup();
  const app = require("express")();
  app.use(require("express").json());
  let gitArgs;
  const router = require("../routes/conductor").createRouter({
    service: conductor,
    spawnGit(...args) {
      gitArgs = args;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  app.use("/api/conductor", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/conductor`;
  async function post(body, headers = {}) {
    return fetch(url + "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  try {
    assert.equal((await post({ cwd: TMP }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ cwd: TMP }, { Referer: "https://evil.example" })).status, 403);
    assert.equal((await post({ cwd: "relative" })).status, 400);
    assert.equal((await post({ cwd: TMP, lead: "codex" })).status, 400);
    assert.equal((await post({ cwd: TMP, codex_sandbox: "invalid" })).status, 400);
    assert.equal((await post({ cwd: path.join(TMP, "new"), create: true })).status, 201);
    assert.deepEqual(gitArgs.slice(0, 2), ["git", ["init"]]);
    assert.equal(gitArgs[2].shell, false);
    assert.equal((await fetch(url + "/orders/missing")).status, 404);
    fs.mkdirSync(path.join(TMP, "browse", "zeta"), { recursive: true });
    fs.mkdirSync(path.join(TMP, "browse", "Alfa"));
    fs.mkdirSync(path.join(TMP, "browse", ".hidden"));
    fs.writeFileSync(path.join(TMP, "browse", "file.txt"), "x");
    const browse = await fetch(
      `${url}/browse?path=${encodeURIComponent(path.join(TMP, "browse"))}`
    );
    assert.equal(browse.status, 200);
    const listing = await browse.json();
    assert.deepEqual(
      listing.dirs.map((d) => d.name),
      ["Alfa", "zeta"]
    );
    assert.equal(listing.parent, TMP);
    assert.ok(Array.isArray(listing.roots) && listing.roots.length > 0);
    assert.equal((await fetch(`${url}/browse?path=relative`)).status, 400);
    assert.equal(
      (await fetch(`${url}/browse?path=${encodeURIComponent(path.join(TMP, "nope"))}`)).status,
      404
    );
    assert.equal(
      (await fetch(`${url}/browse`, { headers: { Origin: "https://evil.example" } })).status,
      403
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Exercise the real adapters against fake children, including default-deny behavior.
test("real spawners preserve defaults, optional Claude flags and unhandled Codex denial", async () => {
  const spawnPath = require.resolve("cross-spawn");
  const priorSpawn = require.cache[spawnPath].exports;
  const modulePaths = [
    "../lib/run-spawner",
    "../lib/codex-app-server",
    "../lib/codex-run-spawner",
  ].map((p) => require.resolve(p));
  const priorModules = modulePaths.map((p) => require.cache[p]);
  const children = [],
    calls = [];
  require.cache[spawnPath].exports = (command, argv, options) => {
    calls.push({ command, argv, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 123;
    child.kill = () => {};
    children.push(child);
    return child;
  };
  for (const p of modulePaths) delete require.cache[p];
  let claudeRuns, codexRuns;
  try {
    claudeRuns = require("../lib/run-spawner");
    codexRuns = require("../lib/codex-run-spawner");
    const seen = [];
    const plain = claudeRuns.spawnRun({ prompt: "test", mode: "conversation", cwd: TMP });
    assert.ok(!calls[0].argv.includes("--mcp-config"));
    assert.equal(calls[0].argv[calls[0].argv.indexOf("--permission-mode") + 1], "acceptEdits");
    const configured = claudeRuns.spawnRun({
      prompt: "test",
      mode: "conversation",
      cwd: TMP,
      mcpConfig: "test.json",
      allowedTools: ["one", "two"],
      permissionPromptTool: "permission",
      env: { CONDUCTOR_ORDER_ID: "test-order" },
      onEnvelope: (e) => seen.push(e),
    });
    assert.equal(calls[1].options.env.CONDUCTOR_ORDER_ID, "test-order");
    assert.ok(calls[1].argv.includes("one,two"));
    assert.ok(calls[1].argv.includes("test.json"));
    children[1].stdout.write('{"type":"result","subtype":"success"}\n');
    assert.equal(seen.length, 1);
    const worker = codexRuns.spawnRun({ prompt: "test", cwd: TMP });
    let output = "";
    worker.server.child.stdin.on("data", (data) => (output += data));
    worker.server.consume(
      '{"id":"approval","method":"item/fileChange/requestApproval","params":{}}\n'
    );
    await new Promise((resolve) => setImmediate(resolve));
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(messages.at(-1), { id: "approval", result: { decision: "decline" } });
    worker.server.consume('{"id":"unsupported","method":"unknown/request","params":{}}\n');
    assert.equal(JSON.parse(output.trim().split("\n").at(-1)).error.code, -32601);
    worker.status = "killed";
    worker.server.close();
    // Allow the initialization rejection to unwind without launching a process.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(plain.id && configured.id);
  } finally {
    claudeRuns?.__reset();
    codexRuns?.__reset();
    require.cache[spawnPath].exports = priorSpawn;
    for (let i = 0; i < modulePaths.length; i++) {
      if (priorModules[i]) require.cache[modulePaths[i]] = priorModules[i];
      else delete require.cache[modulePaths[i]];
    }
  }
});

test("failed turns fail pending polls and cleanup the MCP config", async () => {
  const order = setup();
  const config = [...claude.handles.values()][0].mcpConfig;
  const { roundId } = conductor.handoff({ orderId: order.id, to: "codex", ask: "Hazlo" });
  const { approvalId } = conductor.createApproval({
    orderId: order.id,
    agent: "claude",
    kind: "question",
    summary: "¿Continuar?",
    options: ["Sí", "No"],
  });
  codex.emit({
    method: "turn/completed",
    params: { turn: { status: "failed", error: { message: "failed test turn" } } },
  });
  assert.equal((await conductor.poll("rounds", roundId)).status, "error");
  assert.equal((await conductor.poll("approvals", approvalId)).answer, "stop");
  assert.equal(conductor.getOrder(order.id).status, "error");
  assert.ok(!fs.existsSync(config));
});

test("restart recovery settles unfinished orders, rounds and approvals", async () => {
  const order = setup();
  const { roundId } = conductor.handoff({ orderId: order.id, to: "codex", ask: "Hazlo" });
  const { approvalId } = conductor.createApproval({
    orderId: order.id,
    agent: "claude",
    kind: "question",
    summary: "¿OK?",
  });
  const recovered = createConductor({
    db,
    claude: fake("claude"),
    codex: fake("codex"),
    saveHandoff,
    configRoot: TMP,
    reconcileMs: 0,
    broadcast() {},
  });
  try {
    assert.equal(recovered.getOrder(order.id).status, "error");
    assert.equal((await recovered.poll("rounds", roundId)).status, "error");
    assert.equal((await recovered.poll("approvals", approvalId)).answer, "stop");
  } finally {
    recovered.close();
  }
});

test("handoff deadline releases the caller and rejects overlapping work", async () => {
  const order = setup({ timeoutMs: 10 });
  const { roundId } = conductor.handoff({ orderId: order.id, to: "codex", ask: "Espera" });
  assert.throws(
    () => conductor.handoff({ orderId: order.id, to: "codex", ask: "Otro" }),
    /already pending/
  );
  assert.equal((await conductor.poll("rounds", roundId, 1000)).status, "error");
  assert.equal(conductor.getOrder(order.id).status, "error");
});

test("approval change is idempotent, preserves note and returns to delegation", () => {
  const order = setup();
  conductor.handoff({ orderId: order.id, to: "codex", ask: "Espera" });
  const worker = [...codex.handles.values()][0];
  let decision;
  worker.args.onRequest(
    { id: 1, method: "item/fileChange/requestApproval", params: {} },
    { respond: (_id, result) => (decision = result) }
  );
  const approval = conductor.getOrder(order.id).approvals[0];
  const answer = { answer: "change", note: "Solo el archivo indicado" };
  conductor.answerApproval(approval.id, answer);
  assert.deepEqual(decision, { decision: "decline" });
  assert.equal(conductor.answerApproval(approval.id, answer).note, answer.note);
  assert.throws(
    () => conductor.answerApproval(approval.id, { answer: "approve" }),
    /already answered/
  );
  assert.equal(conductor.getOrder(order.id).status, "delegating");
});

test("an exited idle collaborator is replaced on the next round", () => {
  const order = setup();
  conductor.handoff({ orderId: order.id, to: "codex", ask: "Primero" });
  codex.emit({
    method: "item/completed",
    params: { item: { type: "agent_message", text: "Hecho" } },
  });
  codex.emit({ method: "turn/completed", params: {} });
  const worker = [...codex.handles.values()][0];
  worker.status = "completed";
  worker.args.onStatus("completed", worker);
  conductor.handoff({ orderId: order.id, to: "codex", ask: "Segundo" });
  assert.equal(codex.handles.size, 2);
  assert.equal(conductor.getOrder(order.id).status, "delegating");
});

test("Codex file approvals summarize paths and clip details", () => {
  const order = setup();
  conductor.handoff({ orderId: order.id, to: "codex", ask: "Edita" });
  const worker = [...codex.handles.values()][0];
  worker.args.onRequest(
    {
      id: 9,
      method: "item/fileChange/requestApproval",
      params: {
        changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        diff: "x".repeat(60000),
      },
    },
    { respond() {} }
  );
  const approval = conductor.getOrder(order.id).approvals[0];
  assert.equal(approval.summary, "Cambiar archivos: src/a.ts, src/b.ts");
  assert.equal(approval.detail.length, 50000);
});
test("plan, final summary and per-project order listing feed Dirección's score", () => {
  const order = setup();
  claude.emit({
    type: "assistant",
    message: { content: [{ type: "text", text: "Plan: 1 README, 2 revisión" }] },
  });
  conductor.handoff({ orderId: order.id, to: "codex", ask: "Crea el README" });
  assert.equal(conductor.getOrder(order.id).plan, "Plan: 1 README, 2 revisión");
  codex.emit({ method: "turn/completed", params: { turn: { status: "completed" } } });
  claude.emit({ type: "result", subtype: "success", result: "README creado y revisado." });
  const done = conductor.getOrder(order.id);
  assert.equal(done.result, "README creado y revisado.");
  assert.equal(done.status, "done");
  const listed = conductor.listOrders(done.project_id, 5);
  assert.deepEqual(
    listed.map((row) => row.id),
    [order.id]
  );
  assert.throws(() => conductor.listOrders(done.project_id, 0), /limit/);
  assert.throws(() => conductor.listOrders("missing"), /not found/);
});
test("one lead per project: working orders block new ones, finished ones are retired", () => {
  const first = setup();
  const projectId = conductor.getOrder(first.id).project_id;
  assert.throws(
    () => conductor.createOrder({ projectId, text: "Otra" }, "http://127.0.0.1:4820"),
    (err) => err.status === 409
  );
  claude.emit({ type: "result", subtype: "success", result: "Listo" });
  assert.equal(conductor.getOrder(first.id).status, "done");
  const lead = [...claude.handles.values()][0];
  const second = conductor.createOrder({ projectId, text: "Otra" }, "http://127.0.0.1:4820");
  assert.equal(lead.status, "killed");
  assert.equal(conductor.getOrder(first.id).status, "done");
  assert.equal(conductor.getOrder(second.id).status, "planning");
});
test("agent activity survives partial stream events and is only broadcast on change", () => {
  setup();
  claude.emit({ type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "s" });
  claude.emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "mcp__ccam__dashboard_handoff" }] },
  });
  const before = messages.filter((m) => m.type === "conductor_agent").length;
  claude.emit({ type: "stream_event", event: { type: "content_block_delta" } });
  claude.emit({ type: "user", message: { content: [{ type: "tool_result" }] } });
  const states = messages.filter((m) => m.type === "conductor_agent");
  assert.equal(states.length, before);
  assert.equal(states.at(-1).data.doing, "mcp__ccam__dashboard_handoff");
  assert.equal(states.at(-1).data.model, "claude-opus-5-5");
});
test("stopping a finished order releases its agents but keeps it done", () => {
  const order = setup();
  claude.emit({ type: "result", subtype: "success", result: "Listo" });
  const lead = [...claude.handles.values()][0];
  assert.equal(conductor.stop(order.id).status, "done");
  assert.equal(lead.status, "killed");
});
