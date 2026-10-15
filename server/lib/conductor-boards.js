/**
 * @file Whiteboards for Dirección: Martin describes the project, Claude draws its board live
 *   (one `@pizarra {json}` line per element, read-only run), then Codex draws its own; each
 *   finished board lands in the project's timeline as one sheet. Martin's comments on a board
 *   still drawing reach that agent when its turn ends; from a finished board he can call
 *   Claude or Codex, which starts a new sheet. Spawners and persistence are injectable.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { boardPrompt, boardCommentPrompt } = require("./conductor-prompts");
const { required, problem } = require("./conductor");

const AGENTS = ["claude", "codex"];
const KINDS = new Set(["title", "text", "list", "chart", "image", "code", "arrow"]);
const CHARTS = new Set(["bar", "line", "pie"]);
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ELEMENTS = 60;
const MARK = "@pizarra";
const now = () => new Date().toISOString();

const text = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** One element as the page renders it, or null when the line is not usable. */
function normalizeElement(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  const kind = String(raw.kind || "").toLowerCase();
  if (!id || !KINDS.has(kind)) return null;
  const out = { id, kind };
  if (kind === "arrow") {
    const from = typeof raw.from === "string" && ID.test(raw.from) ? raw.from : null;
    const to = typeof raw.to === "string" && ID.test(raw.to) ? raw.to : null;
    if (!from || !to || from === to) return null;
    Object.assign(out, { from, to });
    const label = text(raw.label, 80);
    if (label) out.label = label;
    return out;
  }
  const title = text(raw.title, 140);
  const body = text(raw.text, 1500);
  if (title) out.title = title;
  if (body) out.text = body;
  if (kind === "list") {
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map((item) => text(item, 240))
      .filter(Boolean)
      .slice(0, 12);
    if (!items.length) return null;
    out.items = items;
  }
  if (kind === "chart") {
    const chart = raw.chart && typeof raw.chart === "object" ? raw.chart : {};
    const labels = (Array.isArray(chart.labels) ? chart.labels : [])
      .map((label) => text(String(label ?? ""), 30) || "")
      .slice(0, 12);
    const values = (Array.isArray(chart.values) ? chart.values : [])
      .slice(0, labels.length)
      .map(Number);
    if (
      !labels.length ||
      values.length !== labels.length ||
      values.some((v) => !Number.isFinite(v))
    )
      return null;
    out.chart = {
      type: CHARTS.has(chart.type) ? chart.type : "bar",
      labels,
      values,
      ...(text(chart.unit, 20) ? { unit: text(chart.unit, 20) } : {}),
    };
  }
  if (kind === "image") {
    if (typeof raw.html !== "string" || !raw.html.trim()) return null;
    out.html = raw.html.slice(0, 30000);
  }
  if (kind === "code") {
    if (typeof raw.code !== "string" || !raw.code.trim()) return null;
    out.code = raw.code.slice(0, 4000);
  }
  if (!title && !body && !["list", "chart", "image", "code"].includes(kind)) return null;
  return out;
}

/** Every `@pizarra {json}` line in a chunk of agent text, normalized; bad lines are skipped. */
function parseBoardLines(chunk) {
  const found = [];
  if (typeof chunk !== "string") return found;
  for (const line of chunk.split(/\r?\n/)) {
    const at = line.indexOf(MARK);
    if (at === -1) continue;
    const json = line.slice(at + MARK.length).trim();
    if (!json.startsWith("{")) continue;
    try {
      const element = normalizeElement(JSON.parse(json));
      if (element) found.push(element);
    } catch {
      /* half-written or invalid line */
    }
  }
  return found;
}

/** Plain-text recap of a board, used as context for the next agent and for calls. */
function summarize(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return elements
    .map((e) => {
      if (e.kind === "arrow")
        return `- ${byId.get(e.from)?.title || e.from} → ${byId.get(e.to)?.title || e.to}${e.label ? ` (${e.label})` : ""}`;
      const parts = [
        e.title,
        e.text,
        e.items?.join("; "),
        e.code && "[código]",
        e.html && "[maqueta]",
      ];
      if (e.chart)
        parts.push(e.chart.labels.map((l, i) => `${l}: ${e.chart.values[i]}`).join(", "));
      return `- ${parts.filter(Boolean).join(" · ")}`;
    })
    .join("\n")
    .slice(0, 8000);
}

function createBoards({
  db = require("../db").db,
  claude = require("./run-spawner"),
  codex = require("./codex-run-spawner"),
  broadcast = require("../websocket").broadcast,
  timeoutMs = 20 * 60 * 1000,
  exitGraceMs = 3000,
} = {}) {
  const runs = new Map(); // boardId -> { handle, buffer, timer, ending }
  const sheetRow = (id) => db.prepare("SELECT * FROM conductor_sheets WHERE id = ?").get(id);
  const boardRow = (id) => db.prepare("SELECT * FROM conductor_boards WHERE id = ?").get(id);
  const elementsOf = (r) => {
    try {
      const value = JSON.parse(r.elements || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  function publicSheet(sheet) {
    const boards = db
      .prepare("SELECT * FROM conductor_boards WHERE sheet_id = ? ORDER BY position")
      .all(sheet.id)
      .map((b) => ({
        id: b.id,
        agent: b.agent,
        status: b.status,
        runId: b.run_id,
        error: b.error,
        elements: elementsOf(b),
        comments: db
          .prepare(
            "SELECT id, element_id, text, status, created_at FROM conductor_board_comments WHERE board_id = ? ORDER BY created_at"
          )
          .all(b.id),
        created_at: b.created_at,
        ended_at: b.ended_at,
      }));
    return {
      id: sheet.id,
      project_id: sheet.project_id,
      n: sheet.n,
      prompt: sheet.prompt,
      agents: sheet.agents.split(","),
      status: sheet.status,
      source_board_id: sheet.source_board_id,
      source_element_id: sheet.source_element_id,
      created_at: sheet.created_at,
      ended_at: sheet.ended_at,
      boards,
    };
  }
  const publish = (sheetId) => {
    const sheet = sheetRow(sheetId);
    if (sheet) broadcast("conductor_sheet", publicSheet(sheet));
    return sheet;
  };
  function patchBoard(id, values) {
    db.prepare(
      `UPDATE conductor_boards SET ${Object.keys(values)
        .map((k) => `${k} = @${k}`)
        .join(",")} WHERE id = @id`
    ).run({ ...values, id });
    return boardRow(id);
  }
  /** Upsert parsed elements; arrows only once both ends exist. Returns true when anything changed. */
  function addElements(boardId, found) {
    if (!found.length) return false;
    const board = boardRow(boardId);
    if (!board || board.status !== "drafting") return false;
    const elements = elementsOf(board);
    let changed = false;
    for (const element of found) {
      const at = elements.findIndex((e) => e.id === element.id);
      if (at >= 0) {
        if (JSON.stringify(elements[at]) === JSON.stringify(element)) continue;
        elements[at] = element;
      } else {
        if (elements.length >= MAX_ELEMENTS) continue;
        elements.push(element);
      }
      changed = true;
    }
    if (!changed) return false;
    patchBoard(boardId, { elements: JSON.stringify(elements) });
    publish(board.sheet_id);
    return true;
  }
  function settleSheet(sheetId) {
    const sheet = sheetRow(sheetId);
    if (!sheet || sheet.status !== "drafting") return;
    const boards = db
      .prepare("SELECT * FROM conductor_boards WHERE sheet_id = ? ORDER BY position")
      .all(sheetId);
    const next = boards.find((b) => b.status === "waiting");
    if (next) {
      const project = db
        .prepare("SELECT * FROM conductor_projects WHERE id = ?")
        .get(sheet.project_id);
      patchBoard(next.id, { status: "drafting" });
      const before = boards
        .filter((b) => b.status === "ready")
        .map((b) => ({ agent: b.agent, summary: summarize(elementsOf(b)) }));
      start(
        next.id,
        next.agent,
        project,
        boardPrompt({ prompt: sheet.prompt, agent: next.agent, before, source: sourceOf(sheet) })
      );
      publish(sheetId);
      return;
    }
    if (boards.some((b) => b.status === "drafting")) return;
    db.prepare("UPDATE conductor_sheets SET status = ?, ended_at = ? WHERE id = ?").run(
      boards.some((b) => b.status === "ready") ? "done" : "error",
      now(),
      sheetId
    );
    publish(sheetId);
  }
  /** Close one board: ready with its elements, or error; then the sheet moves on. */
  function finish(boardId, outcome) {
    const board = boardRow(boardId);
    const runtime = runs.get(boardId);
    if (!board || board.status !== "drafting") return;
    runs.delete(boardId);
    clearTimeout(runtime?.timer);
    const empty = !outcome.error && !outcome.stopped && !elementsOf(board).length;
    // Mark first: killing a run reports its status back here synchronously.
    patchBoard(boardId, {
      status: outcome.stopped ? "stopped" : outcome.error || empty ? "error" : "ready",
      error: outcome.error
        ? String(outcome.error).slice(0, 2000)
        : empty
          ? "No dibujó ningún elemento"
          : null,
      ended_at: now(),
    });
    if (runtime?.handle) (board.agent === "claude" ? claude : codex).killRun(runtime.handle.id);
    db.prepare(
      "UPDATE conductor_board_comments SET status = 'dropped' WHERE board_id = ? AND status = 'pending'"
    ).run(boardId);
    if (outcome.stopped) return publish(board.sheet_id);
    settleSheet(board.sheet_id);
  }
  /** End of an agent turn: deliver queued comments as a new turn, else the board is done. */
  async function turnEnded(boardId) {
    const board = boardRow(boardId);
    const runtime = runs.get(boardId);
    if (!board || board.status !== "drafting" || !runtime) return;
    const pending = db
      .prepare(
        "SELECT * FROM conductor_board_comments WHERE board_id = ? AND status = 'pending' ORDER BY created_at"
      )
      .all(boardId);
    if (!pending.length) return finish(boardId, {});
    const elements = elementsOf(board);
    const prompt = boardCommentPrompt(
      pending.map((c) => ({
        text: c.text,
        elementId: c.element_id,
        element: c.element_id
          ? elements.find((e) => e.id === c.element_id)?.title || c.element_id
          : null,
      }))
    );
    const mark = db.prepare(
      "UPDATE conductor_board_comments SET status = 'sent', sent_at = ? WHERE id = ?"
    );
    for (const c of pending) mark.run(now(), c.id);
    try {
      await (board.agent === "claude" ? claude : codex).sendInput(runtime.handle.id, prompt);
      publish(board.sheet_id);
    } catch (err) {
      finish(boardId, { error: err.message || String(err) });
    }
  }
  function takeText(boardId, chunk, { flush = false } = {}) {
    const runtime = runs.get(boardId);
    if (!runtime) return;
    runtime.buffer += chunk;
    const cut = flush ? runtime.buffer.length : runtime.buffer.lastIndexOf("\n") + 1;
    if (cut <= 0) return;
    const complete = runtime.buffer.slice(0, cut);
    runtime.buffer = runtime.buffer.slice(cut);
    addElements(boardId, parseBoardLines(complete));
  }
  function claudeEvent(boardId, envelope) {
    if (envelope.type === "stream_event") {
      const event = envelope.event || {};
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta")
        takeText(boardId, event.delta.text || "");
      else if (event.type === "content_block_stop") takeText(boardId, "", { flush: true });
      return;
    }
    if (envelope.type === "assistant") {
      // The complete message repeats what the deltas carried; upserts make it idempotent.
      const blocks = envelope.message?.content;
      if (Array.isArray(blocks))
        addElements(
          boardId,
          parseBoardLines(blocks.map((b) => (b?.type === "text" ? b.text : "")).join("\n"))
        );
      return;
    }
    if (envelope.type !== "result") return;
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== "success"))
      finish(boardId, { error: String(envelope.result || "Claude no pudo terminar") });
    else void turnEnded(boardId);
  }
  function codexEvent(boardId, envelope) {
    const method = envelope.method || "";
    const params = envelope.params || {};
    if (/agentMessage\/delta$/i.test(method) && typeof params.delta === "string") {
      takeText(boardId, params.delta);
      return;
    }
    const item = params.item;
    if (
      method === "item/completed" &&
      item &&
      ["agentMessage", "agent_message", "final_answer"].includes(item.type)
    ) {
      const value = item.text || item.message || item.content;
      const full =
        typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.map((p) => p.text || "").join("\n")
            : "";
      takeText(boardId, "", { flush: true });
      addElements(boardId, parseBoardLines(full));
      return;
    }
    if (method !== "turn/completed") return;
    const turn = params.turn;
    if (turn?.error || ["failed", "interrupted"].includes(turn?.status))
      finish(boardId, { error: turn?.error?.message || "Codex no pudo terminar" });
    else void turnEnded(boardId);
  }
  function onStatus(boardId, agent, status) {
    if (!["error", "killed", "completed"].includes(status)) return;
    const fail = () =>
      finish(boardId, { error: `${agent === "claude" ? "Claude" : "Codex"} terminó (${status})` });
    if (status === "completed" && exitGraceMs > 0) setTimeout(fail, exitGraceMs).unref?.();
    else fail();
  }
  function start(boardId, agent, project, prompt) {
    const runtime = { handle: null, buffer: "", timer: null };
    runs.set(boardId, runtime);
    runtime.timer = setTimeout(() => finish(boardId, { error: "Se acabó el tiempo" }), timeoutMs);
    runtime.timer.unref?.();
    try {
      runtime.handle =
        agent === "claude"
          ? claude.spawnRun({
              prompt,
              // Conversation mode keeps stdin open so Martin's comments can follow as new turns.
              mode: "conversation",
              cwd: project.cwd,
              model: project.claude_model,
              effort: project.claude_effort,
              permissionMode: "default",
              allowedTools: ["Read", "Glob", "Grep"],
              onEnvelope: (e) => claudeEvent(boardId, e),
              onStatus: (s) => onStatus(boardId, "claude", s),
            })
          : codex.spawnRun({
              prompt,
              cwd: project.cwd,
              model: project.codex_model,
              effort: project.codex_effort,
              sandbox: "read-only",
              permissionMode: "never",
              onEnvelope: (e) => codexEvent(boardId, e),
              onStatus: (s) => onStatus(boardId, "codex", s),
              onRequest: () => false,
            });
      patchBoard(boardId, { run_id: runtime.handle.id });
    } catch (err) {
      finish(boardId, { error: err.message || String(err) });
    }
  }
  function sourceOf(sheet) {
    if (!sheet.source_board_id) return null;
    const board = boardRow(sheet.source_board_id);
    if (!board) return null;
    const elements = elementsOf(board);
    const element = elements.find((e) => e.id === sheet.source_element_id);
    return { agent: board.agent, element: element?.title || null, summary: summarize(elements) };
  }
  /** A new timeline sheet: both agents in turn, or one agent called from a finished board. */
  function create({
    projectId,
    prompt,
    agent = null,
    sourceBoardId = null,
    sourceElementId = null,
  } = {}) {
    const project = db
      .prepare("SELECT * FROM conductor_projects WHERE id = ?")
      .get(required(projectId, "projectId", 200));
    if (!project) throw problem("project not found", 404);
    prompt = required(prompt, "prompt", 20000);
    if (agent != null && !AGENTS.includes(agent)) throw problem("agent must be claude or codex");
    if (sourceBoardId != null) {
      const source = boardRow(required(sourceBoardId, "sourceBoardId", 200));
      if (!source || sheetRow(source.sheet_id)?.project_id !== project.id)
        throw problem("source board not found", 404);
      if (sourceElementId != null && !ID.test(String(sourceElementId)))
        throw problem("sourceElementId is not valid");
    }
    if (!fs.statSync(project.cwd, { throwIfNoEntry: false })?.isDirectory())
      throw problem("cwd must be an existing directory");
    const busy = db
      .prepare("SELECT id FROM conductor_sheets WHERE project_id = ? AND status = 'drafting'")
      .get(project.id);
    if (busy) throw problem("a whiteboard is still being drawn in this project", 409);
    const agents = agent ? [agent] : AGENTS;
    const id = randomUUID();
    const n =
      (db.prepare("SELECT MAX(n) AS n FROM conductor_sheets WHERE project_id = ?").get(project.id)
        ?.n || 0) + 1;
    const at = now();
    db.prepare(
      `INSERT INTO conductor_sheets (id, project_id, n, prompt, agents, status, source_board_id, source_element_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'drafting', ?, ?, ?)`
    ).run(id, project.id, n, prompt, agents.join(","), sourceBoardId, sourceElementId, at);
    const insert = db.prepare(
      `INSERT INTO conductor_boards (id, sheet_id, agent, position, status, created_at) VALUES (?, ?, ?, ?, 'waiting', ?)`
    );
    agents.forEach((who, position) => insert.run(randomUUID(), id, who, position, at));
    settleSheet(id);
    return publicSheet(sheetRow(id));
  }
  /** Martin's correction on a board that is still being drawn; it reaches the agent at turn end. */
  function comment(boardId, { elementId = null, text: body } = {}) {
    const board = boardRow(required(boardId, "boardId", 200));
    if (!board) throw problem("board not found", 404);
    if (board.status !== "drafting")
      throw problem("this board is finished; call an agent to start a new one", 409);
    body = required(body, "text", 5000);
    if (elementId != null && !ID.test(String(elementId))) throw problem("elementId is not valid");
    const queued = db
      .prepare(
        "SELECT COUNT(*) AS n FROM conductor_board_comments WHERE board_id = ? AND status = 'pending'"
      )
      .get(board.id).n;
    if (queued >= 50) throw problem("too many comments waiting", 429);
    db.prepare(
      "INSERT INTO conductor_board_comments (id, board_id, element_id, text, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(randomUUID(), board.id, elementId, body, now());
    return publicSheet(publish(board.sheet_id));
  }
  function stop(sheetId) {
    const sheet = sheetRow(required(sheetId, "sheetId", 200));
    if (!sheet) throw problem("sheet not found", 404);
    if (sheet.status !== "drafting") return publicSheet(sheet);
    db.prepare("UPDATE conductor_sheets SET status = 'stopped', ended_at = ? WHERE id = ?").run(
      now(),
      sheet.id
    );
    for (const board of db
      .prepare("SELECT id, status FROM conductor_boards WHERE sheet_id = ?")
      .all(sheet.id)) {
      if (board.status === "drafting") finish(board.id, { stopped: true });
      else if (board.status === "waiting")
        patchBoard(board.id, { status: "stopped", ended_at: now() });
    }
    return publicSheet(publish(sheet.id));
  }
  function list(projectId, limit = 30) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 100)
      throw problem("limit must be an integer between 1 and 100");
    return db
      .prepare("SELECT * FROM conductor_sheets WHERE project_id = ? ORDER BY n DESC LIMIT ?")
      .all(required(projectId, "projectId", 200), count)
      .map(publicSheet);
  }
  function get(id) {
    const sheet = sheetRow(required(id, "sheetId", 200));
    if (!sheet) throw problem("sheet not found", 404);
    return publicSheet(sheet);
  }
  // Runs cannot be reattached after a restart; leave no board drawing forever.
  for (const stale of db
    .prepare("SELECT id FROM conductor_sheets WHERE status = 'drafting'")
    .all()) {
    const at = now();
    db.prepare(
      "UPDATE conductor_boards SET status = 'error', error = COALESCE(error, 'Dashboard restarted'), ended_at = ? WHERE sheet_id = ? AND status IN ('drafting', 'waiting')"
    ).run(at, stale.id);
    const ready = db
      .prepare("SELECT 1 FROM conductor_boards WHERE sheet_id = ? AND status = 'ready'")
      .get(stale.id);
    db.prepare("UPDATE conductor_sheets SET status = ?, ended_at = ? WHERE id = ?").run(
      ready ? "done" : "error",
      at,
      stale.id
    );
  }
  function close() {
    for (const id of [...runs.keys()]) finish(id, { error: "Conductor closed" });
  }
  return { create, comment, stop, list, get, close };
}
let singleton;
function getBoards() {
  return (singleton ||= createBoards());
}
module.exports = { createBoards, getBoards, parseBoardLines, normalizeElement, summarize };
