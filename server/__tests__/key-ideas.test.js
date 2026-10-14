/**
 * @file Tests explicit assistant ideas through incremental Claude transcripts,
 * live/imported Codex rollouts, metadata merging and existing session broadcasts.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { it, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "muro-ideas-"));
process.env.DASHBOARD_DB_PATH = path.join(temp, "test.db");
process.env.DASHBOARD_CODEX_HOME = path.join(temp, "codex");
process.env.DASHBOARD_LIVENESS_PROBE = "0";
const { db, stmts } = require("../db");
const frames = [];
const websocket = require("../websocket");
const originalBroadcast = websocket.broadcast;
websocket.broadcast = (type, data) => frames.push({ type, data });
const hooks = require("../routes/hooks");
const TranscriptCache = require("../lib/transcript-cache");
const { extractKeyIdeas, mergeKeyIdeas } = require("../lib/key-ideas");
const { ingestCodexTranscript } = require("../lib/codex-ingest");
const at = "2026-10-14T10:00:00.000Z";
const assistant = (text, timestamp = at) => ({
  type: "assistant",
  timestamp,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const append = (file, entries) =>
  fs.appendFileSync(file, entries.map(JSON.stringify).join("\n") + "\n");
const metadata = (id) => JSON.parse(stmts.getSession.get(id).metadata || "{}");
let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/hooks", hooks);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  websocket.broadcast = originalBroadcast;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
async function hook(id, file, type = "PreToolUse") {
  const response = await fetch(`${base}/hooks/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hook_type: type,
      data: { session_id: id, transcript_path: file, tool_name: "Read", tool_input: {} },
    }),
  });
  assert.equal(response.status, 200);
}

it("normalizes bilingual markers, strips markup, clips Unicode, and ignores code or unmarked prose", () => {
  const input =
    "[ENFOQUE] **Use** `one` source\n[Approach] Use one source\n[Giro] Change plans\n[PIVOT] Another plan\n[RIESGO] Watch latency\n[risk] Watch cost\n[MEJORA] Simpler\n[improvement] Smaller\n```md\n[risk] code\n```\n~~~~\n[giro] code too\n~~~\n[enfoque] still code\n~~~~\n    [risk] indented\nWe considered [risk] inline\n[unknown] Ignore\n[mejora] **``**";
  const ideas = extractKeyIdeas(input, at);
  assert.deepEqual(
    ideas.map((idea) => idea.kind),
    ["approach", "pivot", "pivot", "risk", "risk", "improvement", "improvement"]
  );
  assert.deepEqual(ideas[0], { kind: "approach", text: "Use one source", at });
  assert.equal(extractKeyIdeas(`[risk] ${"🧠".repeat(125)}`, at)[0].text, "🧠".repeat(120));
  const many = Array.from({ length: 15 }, (_, i) => ({
    kind: "approach",
    text: `Idea ${i}`,
    at: new Date(Date.parse(at) + i * 1000).toISOString(),
  }));
  assert.deepEqual(mergeKeyIdeas(many, [many[14]]), many.slice(3));
});

it("accepts list bullets, emphasized markers and separators without including them in the idea", () => {
  for (const [line, kind, text] of [
    ["**[riesgo]** texto", "risk", "texto"],
    ["- [giro] texto", "pivot", "texto"],
    ["[Mejora]: texto", "improvement", "texto"],
    ["* [ENFOQUE] texto", "approach", "texto"],
    ["• _[Risk]_ — texto", "risk", "texto"],
    ["1. **[Pivot]** - texto", "pivot", "texto"],
    ["12. _[improvement]_: **menos** `código`", "improvement", "menos código"],
    ["  - __[approach]__ : una fuente", "approach", "una fuente"],
    ["[risk]—texto", "risk", "texto"],
    [
      "_[enfoque]_ texto: conserva - el resto — aquí",
      "approach",
      "texto: conserva - el resto — aquí",
    ],
  ]) {
    assert.deepEqual(extractKeyIdeas(line, at), [{ kind, text, at }], line);
  }
  assert.deepEqual(
    extractKeyIdeas(
      "```md\n- **[risk]** código\n```\n~~~\n1. _[giro]_: código\n~~~\n    * [risk] código indentado\nTexto - [giro] inline\n**[risk]_ mal cerrado\n[mejora]:",
      at
    ),
    []
  );
  assert.equal(extractKeyIdeas("[giro] texto\n- **[PIVOT]**: texto", at).length, 1);
});

it("carries Claude ideas across incremental reads and excludes user, thinking and sidechain text", () => {
  const file = path.join(temp, "cache.jsonl");
  append(file, [
    assistant("[enfoque] Reuse the cache"),
    { ...assistant("[risk] User text"), type: "user" },
    { ...assistant("[risk] Subagent text"), isSidechain: true },
    {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "[risk] Private thought" }] },
    },
  ]);
  const cache = new TranscriptCache();
  assert.equal(cache.extract(file).keyIdeas.length, 1);
  append(file, [
    assistant("[APPROACH] Reuse the cache\n[giro] Read incrementally", "2026-10-14T10:01:00Z"),
  ]);
  assert.deepEqual(
    cache.extract(file).keyIdeas.map((idea) => idea.text),
    ["Reuse the cache", "Read incrementally"]
  );
  append(file, [{ type: "user", message: { content: "New request" } }]);
  assert.equal(cache.extract(file).keyIdeas.length, 2);
  append(
    file,
    Array.from({ length: 15 }, (_, i) =>
      assistant(
        `[mejora] Improvement ${i}`,
        new Date(Date.parse(at) + (i + 2) * 60000).toISOString()
      )
    )
  );
  assert.equal(cache.extract(file).keyIdeas.length, 12);
  assert.equal(cache.extract(file).keyIdeas[0].text, "Improvement 3");
});

it("persists main Claude ideas on hooks, merges metadata, broadcasts and retains them on completion", async () => {
  const file = path.join(temp, "main.jsonl"),
    id = "claude-ideas";
  append(file, [assistant("[enfoque] One shared parser")]);
  await hook(id, file);
  stmts.updateSession.run(
    null,
    null,
    null,
    JSON.stringify({ ...metadata(id), preserved: { enabled: true } }),
    id
  );
  append(file, [
    assistant("[RISK] Keep metadata\n```\n[giro] Not a real idea\n```", "2026-10-14T10:01:00Z"),
  ]);
  await hook(id, file);
  assert.deepEqual(
    metadata(id).key_ideas.map((idea) => idea.kind),
    ["approach", "risk"]
  );
  assert.deepEqual(metadata(id).preserved, { enabled: true });
  assert.ok(
    frames.some(
      (frame) =>
        frame.type === "session_updated" &&
        frame.data.id === id &&
        JSON.parse(frame.data.metadata || "{}").key_ideas?.length === 2
    )
  );
  const sub = path.join(temp, "agent-child.jsonl");
  append(sub, [assistant("[giro] A subagent decision")]);
  await hook(id, sub);
  assert.equal(metadata(id).key_ideas.length, 2);
  await hook(id, file, "SessionEnd");
  assert.equal(metadata(id).key_ideas.length, 2);
  assert.equal(stmts.getSession.get(id).status, "completed");
});

it("ingests Codex agent_message ideas live and on import with aliases, caps and duplicate safety", () => {
  for (const historical of [false, true]) {
    const id = `codex-ideas-${historical}`,
      file = path.join(process.env.DASHBOARD_CODEX_HOME, "sessions", `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    append(file, [{ type: "session_meta", payload: { id, timestamp: at, cwd: temp } }]);
    ingestCodexTranscript(file, historical ? { liveTranscripts: new Set() } : {});
    stmts.updateSession.run(
      null,
      null,
      null,
      JSON.stringify({ ...metadata(id), retained: "yes" }),
      id
    );
    append(file, [
      {
        type: "event_msg",
        timestamp: at,
        payload: { type: "user_message", message: "[risk] User request" },
      },
      ...[
        "[ENFOQUE] **Reuse** `parsing`",
        "[approach] Reuse parsing",
        "[PIVOT] Switch input",
        "[riesgo] Handle truncation",
        "[IMPROVEMENT] Cache it\n~~~\n[risk] Code only\n~~~",
      ].map((message, i) => ({
        type: "event_msg",
        timestamp: new Date(Date.parse(at) + i * 1000).toISOString(),
        payload: { type: "agent_message", message },
      })),
    ]);
    const options = historical ? { liveTranscripts: new Set() } : {};
    const result = ingestCodexTranscript(file, options);
    assert.equal(result.changed, true);
    assert.deepEqual(
      JSON.parse(result.session.metadata).key_ideas.map((idea) => idea.kind),
      ["approach", "pivot", "risk", "improvement"]
    );
    assert.equal(metadata(id).retained, "yes");
    ingestCodexTranscript(file, options);
    assert.equal(metadata(id).key_ideas.length, 4);
    append(
      file,
      Array.from({ length: 15 }, (_, i) => ({
        type: "event_msg",
        timestamp: new Date(Date.parse(at) + 10000 + i * 1000).toISOString(),
        payload: { type: "agent_message", message: `[mejora] ${i} ${"x".repeat(130)}` },
      }))
    );
    ingestCodexTranscript(file, options);
    assert.equal(metadata(id).key_ideas.length, 12);
    assert.ok(metadata(id).key_ideas[0].text.startsWith("3 "));
    assert.equal(metadata(id).key_ideas[0].text.length, 120);
    assert.equal(metadata(id).retained, "yes");
    if (historical) assert.equal(stmts.getSession.get(id).status, "completed");
  }
});
