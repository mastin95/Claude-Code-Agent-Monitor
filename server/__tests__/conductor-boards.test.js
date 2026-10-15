/**
 * @file Whiteboard tests: `@pizarra` lines become bounded elements live, Claude then Codex draw
 *   in turn, live comments reach the agent at turn end, calls from a board start a one-agent
 *   sheet, and stop/restart never leave a board drawing.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const TMP = fs.mkdtempSync(path.join(__dirname, ".boards-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "test.db");
const { db } = require("../db");
const {
  createBoards,
  parseBoardLines,
  normalizeElement,
  summarize,
} = require("../lib/conductor-boards");

let boards, claude, codex, messages;
function fake(provider) {
  const handles = new Map();
  return {
    handles,
    killed: [],
    inputs: [],
    spawnRun(args) {
      const id = `${provider}-${handles.size}`;
      const handle = { id, args };
      handles.set(id, handle);
      return handle;
    },
    killRun(id) {
      this.killed.push(id);
      handles.get(id)?.args.onStatus?.("killed");
      return true;
    },
    async sendInput(id, text) {
      this.inputs.push({ id, text });
      return { messageId: "m" };
    },
    last() {
      return [...handles.values()].at(-1);
    },
  };
}
const line = (element) => `@pizarra ${JSON.stringify(element)}\n`;
function claudeSays(text) {
  const h = claude.last();
  // Split mid-line to prove only complete lines are parsed while streaming.
  const cut = Math.floor(text.length / 2);
  for (const part of [text.slice(0, cut), text.slice(cut)])
    h.args.onEnvelope({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: part } },
    });
  h.args.onEnvelope({ type: "stream_event", event: { type: "content_block_stop" } });
}
const claudeEnds = () =>
  claude.last().args.onEnvelope({ type: "result", subtype: "success", result: "ok" });
function codexSays(text) {
  codex.last().args.onEnvelope({ method: "item/agentMessage/delta", params: { delta: text } });
}
const codexEnds = () =>
  codex
    .last()
    .args.onEnvelope({ method: "turn/completed", params: { turn: { status: "completed" } } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  boards?.close();
  db.exec("DELETE FROM conductor_board_comments");
  db.exec("DELETE FROM conductor_boards");
  db.exec("DELETE FROM conductor_sheets");
  db.exec("DELETE FROM conductor_projects");
  claude = fake("claude");
  codex = fake("codex");
  messages = [];
  boards = createBoards({
    db,
    claude,
    codex,
    broadcast: (type, data) => messages.push({ type, data }),
    exitGraceMs: 0,
  });
  db.prepare(
    `INSERT INTO conductor_projects (id, cwd, name, lead, claude_model, claude_effort, codex_model, codex_effort, codex_sandbox, created_at)
     VALUES ('p1', ?, 'Test', 'claude', 'sonnet', 'high', 'astra', 'medium', 'workspace-write', ?)`
  ).run(TMP, new Date().toISOString());
});
after(() => {
  boards?.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("parseBoardLines keeps valid elements and skips broken ones", () => {
  const found = parseBoardLines(
    [
      'Pienso un poco. @pizarra {"id":"t","kind":"title","title":"Card Clash"}',
      '@pizarra {"id":"a","kind":"text","title":"Objetivo","text":"Ganar"}',
      '@pizarra {"id":"bad id","kind":"text","title":"x"}',
      '@pizarra {"id":"c","kind":"chart","chart":{"labels":["F1","F2"],"values":[1,"x"]}}',
      '@pizarra {"id":"d","kind":"arrow","from":"t","to":"a"}',
      "@pizarra {roto",
    ].join("\n")
  );
  assert.deepEqual(
    found.map((e) => e.id),
    ["t", "a", "d"]
  );
  assert.equal(normalizeElement({ id: "x", kind: "list", items: [] }), null);
  assert.deepEqual(
    normalizeElement({ id: "g", kind: "chart", chart: { type: "pie", labels: ["a"], values: [3] } })
      .chart,
    { type: "pie", labels: ["a"], values: [3] }
  );
  assert.match(summarize(found), /Card Clash\n- Objetivo · Ganar\n- Card Clash → Objetivo/);
});

test("Claude draws live, then Codex draws its own board with Claude's as context", async () => {
  const sheet = boards.create({ projectId: "p1", prompt: "Un juego de cartas" });
  assert.equal(sheet.n, 1);
  assert.deepEqual(
    sheet.boards.map((b) => [b.agent, b.status]),
    [
      ["claude", "drafting"],
      ["codex", "waiting"],
    ]
  );
  const spawn = claude.last().args;
  assert.equal(spawn.mode, "conversation");
  assert.deepEqual(spawn.allowedTools, ["Read", "Glob", "Grep"]);
  assert.match(spawn.prompt, /Un juego de cartas/);
  assert.match(spawn.prompt, /@pizarra/);

  claudeSays(
    line({ id: "t", kind: "title", title: "Card Clash" }) +
      line({ id: "a", kind: "text", title: "Objetivo", text: "Ganar 3 rondas" })
  );
  let live = messages.at(-1).data;
  assert.equal(live.boards[0].elements.length, 2);
  // The complete assistant message repeats the same lines; nothing is duplicated.
  claude.last().args.onEnvelope({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: line({ id: "a", kind: "text", title: "Objetivo", text: "Ganar 3 rondas" }),
        },
      ],
    },
  });
  assert.equal(boards.get(sheet.id).boards[0].elements.length, 2);

  claudeEnds();
  await flush();
  live = boards.get(sheet.id);
  assert.equal(live.boards[0].status, "ready");
  assert.deepEqual(claude.killed, ["claude-0"]);
  assert.equal(live.boards[1].status, "drafting");
  const codexArgs = codex.last().args;
  assert.equal(codexArgs.sandbox, "read-only");
  assert.match(codexArgs.prompt, /Antes que tú, Claude dibujó esta pizarra:\n- Card Clash/);

  codexSays(line({ id: "t", kind: "title", title: "Técnica" }));
  codexEnds();
  await flush();
  live = boards.get(sheet.id);
  assert.equal(live.status, "done");
  assert.equal(live.boards[1].status, "ready");
  assert.ok(messages.every((m) => m.type === "conductor_sheet"));
});

test("live comments reach the drawing agent when its turn ends", async () => {
  const sheet = boards.create({ projectId: "p1", prompt: "Un juego" });
  const board = sheet.boards[0];
  claudeSays(line({ id: "a", kind: "text", title: "Objetivo", text: "Ganar" }));
  boards.comment(board.id, { elementId: "a", text: "Mejor 5 rondas" });
  claudeEnds();
  await flush();
  assert.equal(claude.inputs.length, 1);
  assert.match(claude.inputs[0].text, /Sobre «Objetivo» \(id a\): Mejor 5 rondas/);
  let live = boards.get(sheet.id);
  assert.equal(live.boards[0].status, "drafting");
  assert.equal(live.boards[0].comments[0].status, "sent");

  claudeSays(line({ id: "a", kind: "text", title: "Objetivo", text: "Ganar 5 rondas" }));
  claudeEnds();
  await flush();
  live = boards.get(sheet.id);
  assert.equal(live.boards[0].status, "ready");
  assert.equal(live.boards[0].elements[0].text, "Ganar 5 rondas");
  assert.throws(() => boards.comment(board.id, { text: "tarde" }), /finished/);
});

test("calling an agent from a finished board starts a one-agent sheet", async () => {
  const first = boards.create({ projectId: "p1", prompt: "Un juego" });
  assert.throws(() => boards.create({ projectId: "p1", prompt: "otra" }), /still being drawn/);
  claudeSays(line({ id: "a", kind: "text", title: "Objetivo", text: "Ganar" }));
  claudeEnds();
  await flush();
  codexSays(line({ id: "b", kind: "text", title: "Base", text: "React" }));
  codexEnds();
  await flush();

  const second = boards.create({
    projectId: "p1",
    prompt: "Dame tres variantes",
    agent: "codex",
    sourceBoardId: first.boards[0].id,
    sourceElementId: "a",
  });
  assert.equal(second.n, 2);
  assert.deepEqual(second.agents, ["codex"]);
  assert.match(
    codex.last().args.prompt,
    /desde la pizarra de Claude, sobre el elemento «Objetivo»/
  );
  assert.equal(boards.list("p1").length, 2);
});

test("a board with nothing drawn fails, and the next agent still draws", async () => {
  const sheet = boards.create({ projectId: "p1", prompt: "Un juego" });
  claudeEnds();
  await flush();
  const live = boards.get(sheet.id);
  assert.equal(live.boards[0].status, "error");
  assert.match(live.boards[0].error, /ningún elemento/);
  assert.equal(live.boards[1].status, "drafting");
});

test("stop ends the drawing board and skips the waiting one", () => {
  const sheet = boards.create({ projectId: "p1", prompt: "Un juego" });
  const stopped = boards.stop(sheet.id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(
    stopped.boards.map((b) => b.status),
    ["stopped", "stopped"]
  );
  assert.equal(codex.handles.size, 0);
});

test("a restart closes sheets that were still drawing", () => {
  const sheet = boards.create({ projectId: "p1", prompt: "Un juego" });
  claudeSays(line({ id: "a", kind: "text", title: "Objetivo", text: "Ganar" }));
  const again = createBoards({
    db,
    claude: fake("claude"),
    codex: fake("codex"),
    broadcast: () => {},
  });
  const live = again.get(sheet.id);
  assert.equal(live.status, "error");
  assert.deepEqual(
    live.boards.map((b) => b.status),
    ["error", "error"]
  );
});
