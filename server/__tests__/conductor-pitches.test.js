/**
 * @file Pitch duel tests: both agents propose read-only, JSON pitches are parsed and bounded,
 *   failures stay per side, and Martin's mix becomes one order for the lead.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const TMP = fs.mkdtempSync(path.join(__dirname, ".pitches-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "test.db");
const { db } = require("../db");
const { createPitches, extractJson, normalizePitch } = require("../lib/conductor-pitches");

let duel, claude, codex, messages, orders, project;
function fake(provider) {
  const handles = new Map();
  return {
    handles,
    killed: [],
    spawnRun(args) {
      const id = `${provider}-${handles.size}`;
      const handle = { ...args, id, args };
      handles.set(id, handle);
      return handle;
    },
    killRun(id) {
      this.killed.push(id);
      handles.get(id)?.args.onStatus?.("killed");
      return true;
    },
    last() {
      return [...handles.values()].at(-1);
    },
  };
}
const PITCH = {
  name: "La Taberna",
  tagline: "Marcador con alma de juego de mesa",
  cards: [
    { kind: "estilo", title: "Pergamino", body: "Cálido", swatches: ["#F4E3C1", "red", "#8B4A2B"] },
    {
      kind: "pantallas",
      title: "Pantallas",
      screens: [{ label: "Mesa", html: "<div style='color:red'>3-2</div>" }],
    },
    { kind: "rara", title: "Otra cosa", items: ["a", "", 7, "b"] },
  ],
};
function setup() {
  claude = fake("claude");
  codex = fake("codex");
  messages = [];
  orders = [];
  duel = createPitches({
    db,
    claude,
    codex,
    broadcast: (type, data) => messages.push({ type, data }),
    exitGraceMs: 0,
    conductor: {
      createOrder: (input, baseUrl) => {
        orders.push({ input, baseUrl });
        return { id: "order-1", ...input };
      },
    },
  });
  project = {
    id: "p1",
    cwd: TMP,
    name: "Test",
    lead: "claude",
    claude_model: "sonnet",
    claude_effort: "medium",
    codex_model: "astra",
    codex_effort: "medium",
    codex_sandbox: "workspace-write",
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO conductor_projects (id, cwd, name, lead, claude_model, claude_effort, codex_model, codex_effort, codex_sandbox, created_at)
     VALUES (@id, @cwd, @name, @lead, @claude_model, @claude_effort, @codex_model, @codex_effort, @codex_sandbox, @created_at)`
  ).run(project);
}
const claudeAnswers = (text) =>
  claude.last().args.onEnvelope({ type: "result", subtype: "success", result: text });
function codexAnswers(text) {
  const h = codex.last();
  h.args.onEnvelope({
    method: "item/completed",
    params: { item: { type: "agentMessage", text } },
  });
  h.args.onEnvelope({ method: "turn/completed", params: { turn: { status: "completed" } } });
}

beforeEach(() => {
  duel?.close();
  db.exec("DELETE FROM conductor_pitches");
  db.exec("DELETE FROM conductor_projects");
  setup();
});
after(() => {
  duel?.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("extractJson reads a fenced block or bare braces", () => {
  assert.deepEqual(extractJson('Aquí va:\n```json\n{"a":1}\n```\nfin'), { a: 1 });
  assert.deepEqual(extractJson('texto {"b":2} texto'), { b: 2 });
  assert.equal(extractJson("sin json"), null);
});

test("normalizePitch bounds fields, drops bad colours and maps unknown kinds", () => {
  const pitch = normalizePitch(PITCH);
  assert.deepEqual(pitch.cards[0].swatches, ["#F4E3C1", "#8B4A2B"]);
  assert.equal(pitch.cards[1].screens[0].label, "Mesa");
  assert.equal(pitch.cards[2].kind, "otra");
  assert.deepEqual(pitch.cards[2].items, ["a", "b"]);
  assert.throws(() => normalizePitch({ name: "x", cards: [] }), /no cards/);
});

test("both agents start read-only in the project folder with the depth's effort", () => {
  const pitch = duel.create({ projectId: "p1", idea: "Un marcador de cartas", depth: "deep" });
  assert.equal(pitch.status, "drafting");
  const lead = claude.last().args;
  assert.equal(lead.mode, "headless");
  assert.equal(lead.permissionMode, "default");
  assert.deepEqual(lead.allowedTools, ["Read", "Glob", "Grep"]);
  assert.equal(lead.effort, "high");
  assert.equal(lead.cwd, TMP);
  assert.match(lead.prompt, /Un marcador de cartas/);
  const worker = codex.last().args;
  assert.equal(worker.sandbox, "read-only");
  assert.equal(worker.permissionMode, "never");
  assert.equal(worker.effort, "high");
  assert.throws(
    () => duel.create({ projectId: "p1", idea: "Otra" }),
    (err) => err.status === 409
  );
  assert.throws(() => duel.create({ projectId: "p1", idea: "x", depth: "huge" }), /depth/);
});

test("pitches settle per side, then Martin's mix becomes the lead's order", () => {
  const { id } = duel.create({ projectId: "p1", idea: "Un marcador de cartas" });
  claudeAnswers("```json\n" + JSON.stringify(PITCH) + "\n```");
  // Headless Claude exits by itself after its result: nothing to kill, no error.
  claude.last().args.onStatus("completed");
  assert.equal(duel.get(id).claude.status, "ready");
  assert.equal(duel.get(id).status, "drafting");
  codexAnswers(JSON.stringify({ ...PITCH, name: "Arcade Score" }));
  assert.deepEqual(codex.killed, ["codex-0"]);
  const ready = duel.get(id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.codex.pitch.name, "Arcade Score");
  assert.ok(messages.every((m) => m.type === "conductor_pitch"));

  assert.throws(() => duel.choose(id, { picks: [] }), /picks/);
  assert.throws(() => duel.choose(id, { picks: [{ agent: "codex", index: 9 }] }), /no card/);
  assert.throws(() => duel.choose(id, { picks: [{ agent: "claude", index: 0 }], lead: "codex" }));
  const order = duel.choose(
    id,
    {
      picks: [
        { agent: "claude", index: 0 },
        { agent: "codex", index: 1 },
      ],
      note: "Que se vea en la tele",
    },
    "http://127.0.0.1:4820"
  );
  assert.equal(order.id, "order-1");
  const { input, baseUrl } = orders[0];
  assert.equal(input.projectId, "p1");
  assert.equal(baseUrl, "http://127.0.0.1:4820");
  assert.match(input.text, /^Un marcador de cartas/);
  assert.match(input.text, /ESTILO · de Claude \(«La Taberna»\)/);
  assert.match(input.text, /PANTALLAS · de Codex \(«Arcade Score»\)/);
  assert.match(input.text, /3-2/);
  assert.match(input.text, /Nota de Martin: Que se vea en la tele/);
  assert.equal(duel.get(id).status, "used");
  assert.equal(duel.get(id).order_id, "order-1");
  assert.throws(() => duel.choose(id, { picks: [{ agent: "claude", index: 0 }] }), /not ready/);
});

test("a failed side keeps the other; unreadable answers and early exits are errors", () => {
  const { id } = duel.create({ projectId: "p1", idea: "Idea" });
  claudeAnswers("No tengo JSON para ti");
  assert.equal(duel.get(id).claude.status, "error");
  assert.match(duel.get(id).claude.error, /No se pudo leer/);
  codex.last().args.onStatus("error");
  const settled = duel.get(id);
  assert.equal(settled.codex.status, "error");
  assert.equal(settled.status, "error");

  const second = duel.create({ projectId: "p1", idea: "Idea 2" });
  codexAnswers(JSON.stringify(PITCH));
  claude.last().args.onEnvelope({ type: "result", subtype: "error_max_turns", is_error: true });
  assert.equal(duel.get(second.id).status, "ready");
  assert.equal(duel.list("p1", 1)[0].id, second.id);
});

test("stopping a drafting duel kills both runs; restart closes stale duels", () => {
  const { id } = duel.create({ projectId: "p1", idea: "Idea" });
  const stopped = duel.stop(id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(claude.killed, ["claude-0"]);
  assert.deepEqual(codex.killed, ["codex-0"]);

  const live = duel.create({ projectId: "p1", idea: "Otra" });
  createPitches({ db, claude: fake("claude"), codex: fake("codex"), broadcast: () => {} });
  const stale = duel.get(live.id);
  assert.equal(stale.status, "error");
  assert.equal(stale.claude.error, "Dashboard restarted");
});

test("a clean exit waits for a late result before failing the side", async () => {
  duel.close();
  duel = createPitches({ db, claude, codex, broadcast: () => {}, exitGraceMs: 20 });
  const { id } = duel.create({ projectId: "p1", idea: "Idea" });
  claude.last().args.onStatus("completed");
  claudeAnswers(JSON.stringify(PITCH));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(duel.get(id).claude.status, "ready");
});
