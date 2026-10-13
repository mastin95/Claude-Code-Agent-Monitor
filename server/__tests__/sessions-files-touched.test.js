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
const { createApp } = require("../index");
const { db } = require("../db");
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
