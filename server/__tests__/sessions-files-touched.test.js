/**
 * @file Integration tests for bounded file paths in session stats and effective list tokens.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { before, after, beforeEach, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muro-files-"));
process.env.DASHBOARD_DB_PATH = path.join(dir, "test.db");
process.env.DASHBOARD_DATA_DIR = dir;
process.env.DASHBOARD_LIVENESS_PROBE = "0";
process.env.DASHBOARD_CODEX_HOME = path.join(dir, "codex");
const { createApp } = require("../index");
const { db } = require("../db");
const { ingestCodexHook, ingestCodexTranscript } = require("../lib/codex-ingest");
let server, base;
before(async () => {
  server = await new Promise((resolve) => {
    const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  db.exec("DELETE FROM sessions");
  for (const id of ["one", "other"])
    db.prepare(
      "INSERT INTO sessions (id, provider, source, status) VALUES (?, 'claude', 'local', 'active')"
    ).run(id);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function event(tool, data, type = "PreToolUse", session = "one") {
  db.prepare("INSERT INTO events (session_id,event_type,tool_name,data) VALUES (?,?,?,?)").run(
    session,
    type,
    tool,
    typeof data === "string" ? data : JSON.stringify(data)
  );
}
async function stats(query = "") {
  const response = await fetch(`${base}/api/sessions/one/stats${query}`);
  return { status: response.status, body: await response.json() };
}
it("returns unique paths only from edit/write pre-tool events, ignoring invalid payloads", async () => {
  event("Edit", { tool_input: { file_path: "src/a.ts" } });
  event("Write", { tool_input: { file_path: "src/a.ts" } });
  event("MultiEdit", { tool_input: { file_path: "src/b.ts" } });
  event("Read", { tool_input: { file_path: "read.ts" } });
  event("Edit", { tool_input: { file_path: "post.ts" } }, "PostToolUse");
  event("Write", { tool_input: { file_path: "other.ts" } }, "PreToolUse", "other");
  for (const data of [
    "{invalid",
    "null",
    {},
    { tool_input: { file_path: null } },
    { tool_input: { file_path: 42 } },
    { tool_input: { file_path: [] } },
    { tool_input: { file_path: "  " } },
  ])
    event("Edit", data);
  const result = await stats();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.files_touched, ["src/a.ts", "src/b.ts"]);
  assert.equal(result.body.total_events, 12);
  assert.ok(result.body.tools_used.length);
  assert.deepEqual(result.body.tokens, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
});
it("returns an empty array without file events and enforces source/provider scope", async () => {
  assert.deepEqual((await stats()).body.files_touched, []);
  assert.equal((await stats("?sources=remote")).status, 404);
  assert.equal((await stats("?providers=codex")).status, 404);
});
it("caps unique paths at 50 with deterministic ordering after deduplication", async () => {
  for (let i = 59; i >= 0; i--)
    for (let repeat = 0; repeat < 2; repeat++)
      event("Edit", { tool_input: { file_path: `file-${String(i).padStart(2, "0")}.ts` } });
  const files = (await stats()).body.files_touched;
  assert.equal(files.length, 50);
  assert.equal(files[0], "file-00.ts");
  assert.equal(files[49], "file-49.ts");
});
it("returns effective list tokens for time and price sorts without changing stats tokens", async () => {
  db.prepare(
    "INSERT INTO token_usage (session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,baseline_input,baseline_output,baseline_cache_read,baseline_cache_write) VALUES ('one','test',1,2,3,4,10,20,30,40)"
  ).run();
  for (const sort of ["time", "price"]) {
    const result = await (await fetch(`${base}/api/sessions?sort_by=${sort}`)).json();
    assert.equal(result.sessions.find((s) => s.id === "one").total_tokens, 110);
    assert.equal(result.sessions.find((s) => s.id === "other").total_tokens, 0);
  }
  assert.equal(
    Object.values((await stats()).body.tokens).reduce((a, b) => a + b, 0),
    10
  );
});

const patch =
  "*** Begin Patch\r\n*** Add File: src/new.ts\r\n+*** Delete File: not-a-header.ts\r\n*** Update File: src/edit.ts\r\n@@\r\n-old\r\n+new\r\n*** Delete File: src/deleted.ts\r\n*** Update File: src/edit.ts\r\n*** End Patch";
it("ingests apply_patch file headers from rollout custom and function calls into stats", async () => {
  const id = "019a4ba6-a2b6-75f0-b186-bddd23ae4a99";
  const rollout = path.join(dir, `rollout-${id}.jsonl`);
  const record = (type, payload) => ({ type, timestamp: "2026-10-13T10:00:00Z", payload });
  fs.writeFileSync(
    rollout,
    [
      record("session_meta", { id, cwd: dir, timestamp: "2026-10-13T10:00:00Z" }),
      record("response_item", {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "patch1",
        input: patch,
      }),
      record("response_item", {
        type: "function_call",
        name: "apply_patch",
        call_id: "patch2",
        arguments: JSON.stringify({ patch: "*** Add File: src/function.ts\n" }),
      }),
      record("response_item", {
        type: "custom_tool_call",
        name: "exec_command",
        call_id: "shell",
        input: patch,
      }),
    ]
      .map(JSON.stringify)
      .join("\n") + "\n"
  );
  ingestCodexTranscript(rollout, { confirmedLive: true, root: dir });
  ingestCodexTranscript(rollout, { confirmedLive: true, root: dir });
  const rows = db
    .prepare("SELECT data FROM events WHERE session_id = ? AND tool_name = 'Edit'")
    .all(id);
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].data).files, ["src/new.ts", "src/edit.ts", "src/deleted.ts"]);
  event("Edit", { tool_input: { file_path: "src/new.ts" } }, "PreToolUse", id);
  const result = await (await fetch(`${base}/api/sessions/${id}/stats?providers=codex`)).json();
  assert.deepEqual(result.files_touched, [
    "src/deleted.ts",
    "src/edit.ts",
    "src/function.ts",
    "src/new.ts",
  ]);
});
it("ingests hook apply_patch strings and objects, deduplicates and caps paths at 50", async () => {
  const id = "019a4ba6-a2b6-75f0-b186-bddd23ae4b99";
  const hookData = { session_id: id, transcript_path: null, cwd: dir };
  ingestCodexHook(null, "SessionStart", hookData);
  for (const input of [
    patch,
    { input: patch },
    { patch },
    JSON.stringify({ patch }),
    null,
    { patch: 42 },
    "{bad json",
  ]) {
    ingestCodexHook(null, "PreToolUse", {
      ...hookData,
      tool_name: "apply_patch",
      tool_input: input,
    });
  }
  let result = await (await fetch(`${base}/api/sessions/${id}/stats`)).json();
  assert.deepEqual(result.files_touched, ["src/deleted.ts", "src/edit.ts", "src/new.ts"]);
  const many = Array.from(
    { length: 60 },
    (_, i) => `*** Add File: file-${String(i).padStart(2, "0")}.ts`
  ).join("\n");
  ingestCodexHook(null, "PreToolUse", { ...hookData, tool_name: "apply_patch", tool_input: many });
  const last = JSON.parse(
    db
      .prepare(
        "SELECT data FROM events WHERE session_id=? AND event_type='codex_tool_call' ORDER BY id DESC LIMIT 1"
      )
      .get(id).data
  );
  assert.equal(last.files.length, 50);
  assert.equal(last.files[49], "file-49.ts");
  result = await (await fetch(`${base}/api/sessions/${id}/stats`)).json();
  assert.equal(result.files_touched.length, 50);
  assert.equal(result.files_touched[49], "file-49.ts");
});
it("ignores malformed Codex file arrays, non-patch calls, and other sessions", async () => {
  for (const files of ["bad", { path: "bad.ts" }, null, [null, 42, {}, [], "", "   "]])
    event("Edit", { raw_tool_name: "apply_patch", files }, "codex_tool_call");
  event("Edit", "{invalid", "codex_tool_call");
  event("Bash", { raw_tool_name: "exec_command", files: ["bad.ts"] }, "codex_tool_call");
  event("Edit", { raw_tool_name: "apply_patch", files: ["other.ts"] }, "codex_tool_call", "other");
  event("Edit", { raw_tool_name: "apply_patch", files: ["good.ts", "good.ts"] }, "codex_tool_call");
  assert.deepEqual((await stats()).body.files_touched, ["good.ts"]);
});
