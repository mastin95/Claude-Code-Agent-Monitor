/**
 * @file Tests real Companion metadata, incremental rounds, clipping and late
 * Bash parent links across main/subagent transcripts and Windows cwd fallback.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { after, beforeEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-handoffs-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.DASHBOARD_DATA_DIR = path.join(TMP, "data");
process.env.DASHBOARD_CODEX_HOME = path.join(TMP, "codex");
process.env.CLAUDE_HOME = path.join(TMP, "claude");
const { db, stmts } = require("../db");
const {
  ingestCodexTranscript,
  refreshCodexSessionTitles,
  setReadWindowBytesForTests,
} = require("../lib/codex-ingest");
const { reconcileHandoffParents: reconcile, reduceHandoff } = require("../lib/codex-handoffs");
const reconcileHandoffParents = (options = {}) =>
  reconcile({ jobRoots: [path.join(TMP, `jobs-${sequence}`)], ...options });
const ID = "01a13aca-eb31-7cd3-bf42-66a9e6a937c1";
const cwd = "C:\\Users\\Martin\\Documents\\Card_Game";
let sequence = 0,
  file,
  project;
const at = (minute) => `2026-10-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
const record = (type, payload, minute = 1) => ({ type, timestamp: at(minute), payload });
function append(records, target = file) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, records.map((value) => JSON.stringify(value)).join("\n") + "\n");
}
function rollout(originator = "Claude Code") {
  append([
    record("session_meta", {
      id: ID,
      session_id: ID,
      timestamp: at(1),
      cwd,
      originator,
      source: "vscode",
      cli_version: "0.162.0-alpha.17.2",
    }),
  ]);
}
const metadata = () => JSON.parse(stmts.getSession.get(ID).metadata);
function claude(id, overrides = {}) {
  const row = { id, cwd, source: "local", status: "active", start: at(0), end: null, ...overrides };
  db.prepare(
    "INSERT INTO sessions (id, provider, cwd, source, status, started_at, ended_at) VALUES (?, 'claude', ?, ?, ?, ?, ?)"
  ).run(row.id, row.cwd, row.source, row.status, row.start, row.end);
}
function bashResult(target, name = "Bash") {
  append(
    [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "bash-1",
              name,
              input: { command: "node codex-companion.mjs task" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "bash-1",
              content: [
                {
                  type: "text",
                  text: `[codex] Thread ready (${ID}).\n[codex] Turn started (turn-1).`,
                },
              ],
            },
          ],
        },
      },
    ],
    target
  );
}
beforeEach(() => {
  db.exec("DELETE FROM sessions");
  sequence++;
  process.env.CLAUDE_HOME = path.join(TMP, `claude-${sequence}`);
  project = path.join(process.env.CLAUDE_HOME, "projects", `project-${sequence}`);
  file = path.join(
    process.env.DASHBOARD_CODEX_HOME,
    "sessions",
    `${sequence}`,
    `rollout-${ID}.jsonl`
  );
});
after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("Claude → Codex handoffs", () => {
  for (const count of [1, 2])
    it(`reads the real 0.162 format with ${count} turns without mirrors`, () => {
      const fixture = require(`./fixtures/codex-companion-0162-${count}-turn.json`);
      // Ingest each record separately to exercise persisted phase priority/cursors.
      for (const entry of fixture.records) {
        append([entry]);
        ingestCodexTranscript(file);
        if (
          entry.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes(
            "user.text"
          )
        ) {
          assert.equal(stmts.getSession.get(ID).awaiting_input_since, null);
          assert.equal(metadata().handoff.rounds.at(-1).reply, null);
        }
      }
      assert.deepEqual(metadata().handoff, fixture.expected.handoff);
      assert.equal(stmts.getSession.get(ID).awaiting_reason, fixture.expected.awaiting_reason);
      assert.ok(stmts.getSession.get(ID).awaiting_input_since);
      const old = metadata();
      old.handoff_version = 1;
      old.handoff.rounds.forEach((round) => {
        round.reply = null;
        round.reply_at = null;
      });
      old.handoff.parent_session_id = "known-parent";
      old.handoff_parent_evidence = "job";
      stmts.updateSession.run(null, null, null, JSON.stringify(old), ID);
      assert.equal(ingestCodexTranscript(file).changed, true);
      assert.deepEqual(metadata().handoff.rounds, fixture.expected.handoff.rounds);
      assert.equal(metadata().handoff.parent_session_id, "known-parent");
      assert.equal(metadata().handoff_parent_evidence, "job");
    });
  it("prefers final answers over later commentary and task_complete over either", () => {
    const fixture = require("./fixtures/codex-companion-0162-1-turn.json");
    const cursor = {};
    let handoff = null;
    for (const entry of fixture.records.slice(0, -1))
      handoff = reduceHandoff(handoff, entry, cursor);
    const commentary = record(
      "response_item",
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Later commentary" }],
      },
      8
    );
    reduceHandoff(handoff, commentary, cursor);
    assert.equal(handoff.rounds[0].reply, "The implementation is correct.");
    assert.equal(handoff.rounds[0].reply_at, at(4));
    reduceHandoff(handoff, fixture.records.at(-1), cursor);
    reduceHandoff(handoff, commentary, cursor);
    assert.deepEqual(handoff, fixture.expected.handoff);
  });
  it("links cached jobs ahead of transcripts/cwd, even before a different-cwd parent arrives", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("fallback");
    bashResult(path.join(project, "transcript-parent.jsonl"));
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "transcript-parent");
    const root = path.join(TMP, `jobs-${sequence}`);
    const jobPath = path.join(root, "workspace-hash", "jobs", "task-123.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        id: "task-123",
        kind: "task",
        workspaceRoot: "D:/clone",
        sessionId: "job-parent",
        threadId: ID,
        status: "completed",
      })
    );
    assert.equal(reconcileHandoffParents().length, 1);
    assert.equal(metadata().handoff.parent_session_id, "job-parent");
    claude("job-parent", { cwd: "D:/other" });
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (target, ...args) {
      if (target === jobPath) reads++;
      return read.call(this, target, ...args);
    };
    try {
      assert.equal(reconcileHandoffParents().length, 0);
      assert.equal(reads, 0);
    } finally {
      fs.readFileSync = read;
    }
    fs.writeFileSync(
      jobPath,
      JSON.stringify({ kind: "task", sessionId: "updated-job-parent", threadId: ID })
    );
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "updated-job-parent");
  });
  it("discovers configured plugin state and temporary fallback roots, scoped to local sessions", () => {
    rollout();
    ingestCodexTranscript(file);
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    const tmpdir = os.tmpdir;
    const root = path.join(TMP, `default-roots-${sequence}`);
    process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin");
    os.tmpdir = () => path.join(root, "temp");
    try {
      for (const base of [
        path.join(process.env.CLAUDE_PLUGIN_DATA, "state"),
        path.join(os.tmpdir(), "codex-companion"),
      ]) {
        const dir = path.join(base, "workspace-hash", "jobs");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "task.json"),
          JSON.stringify({ threadId: ID, sessionId: "exact-parent" })
        );
        reconcile();
        assert.equal(metadata().handoff.parent_session_id, "exact-parent");
        // Reset persisted evidence so each root must independently prove the link.
        const value = metadata();
        value.handoff.parent_session_id = null;
        delete value.handoff_parent_evidence;
        stmts.updateSession.run(null, null, null, JSON.stringify(value), ID);
        fs.unlinkSync(path.join(dir, "task.json"));
      }
      db.prepare("UPDATE sessions SET source = 'remote:other' WHERE id = ?").run(ID);
      const dir = path.join(process.env.CLAUDE_PLUGIN_DATA, "state", "workspace-hash", "jobs");
      fs.writeFileSync(
        path.join(dir, "task.json"),
        JSON.stringify({ kind: "task", threadId: ID, sessionId: "local-parent" })
      );
      reconcile();
      assert.equal(metadata().handoff.parent_session_id, null);
    } finally {
      os.tmpdir = tmpdir;
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  });
  it("ignores absent job directories and jobs without sessionId, retaining fallbacks", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("fallback");
    assert.doesNotThrow(() => reconcileHandoffParents({ jobRoots: [path.join(TMP, "absent")] }));
    assert.equal(metadata().handoff.parent_session_id, "fallback");
    const root = path.join(TMP, `jobs-${sequence}`);
    const dir = path.join(root, "workspace", "jobs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ kind: "task", threadId: ID }));
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "fallback");
    bashResult(path.join(project, "explicit.jsonl"));
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "explicit");
  });
  it("requires the exact originator, preserves metadata and strips only Companion titles", () => {
    rollout("codex_cli_rs");
    fs.writeFileSync(
      path.join(process.env.DASHBOARD_CODEX_HOME, "session_index.jsonl"),
      JSON.stringify({
        id: ID,
        thread_name:
          "Codex Companion Task: Read-only. Do not edit, create or delete any file. In...",
        updated_at: at(1),
      }) + "\n"
    );
    ingestCodexTranscript(file);
    assert.equal(metadata().handoff, undefined);
    assert.match(stmts.getSession.get(ID).name, /^Codex Companion Task:/);
    db.exec("DELETE FROM sessions");
    rollout();
    ingestCodexTranscript(file);
    assert.equal(metadata().handoff.from, "claude");
    assert.equal(metadata().cli_version, "0.162.0-alpha.17.2");
    assert.equal(metadata().handoff.parent_session_id, null);
    assert.match(stmts.getSession.get(ID).name, /^Read-only\./);
    assert.equal(refreshCodexSessionTitles().length, 0);
  });
  it("retains the last reply per round, clips Unicode text and is append-idempotent", () => {
    rollout();
    append([
      record("event_msg", { type: "user_message", message: "First line\n" + "🦊".repeat(2100) }),
      record("event_msg", { type: "agent_message", message: "Draft" }, 2),
      record("event_msg", { type: "agent_message", message: "Reply\n" + "x".repeat(2200) }, 3),
    ]);
    ingestCodexTranscript(file);
    let rounds = metadata().handoff.rounds;
    assert.equal(rounds.length, 1);
    assert.equal(Array.from(rounds[0].ask).length, 2000);
    assert.equal(rounds[0].reply.length, 2000);
    assert.equal(rounds[0].reply_at, at(3));
    append([record("event_msg", { type: "user_message", message: "Second ask" }, 4)]);
    ingestCodexTranscript(file);
    rounds = metadata().handoff.rounds;
    assert.equal(rounds.length, 2);
    assert.equal(rounds[1].reply, null);
    append([record("event_msg", { type: "agent_message", message: "Final answer" }, 5)]);
    const updated = ingestCodexTranscript(file);
    assert.equal(updated.changed, true);
    assert.equal(JSON.parse(updated.session.metadata).handoff.rounds[1].reply, "Final answer");
    assert.equal(ingestCodexTranscript(file).changed, false);
  });
  it("deduplicates mirrored user records across windows and excludes injected instructions", () => {
    rollout();
    append([
      record("event_msg", { type: "user_message", message: "Do the work" }),
      record("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Do the work" }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
      }),
      record("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "AGENTS instructions" }],
      }),
    ]);
    setReadWindowBytesForTests(128);
    try {
      ingestCodexTranscript(file);
    } finally {
      setReadWindowBytesForTests();
    }
    assert.equal(metadata().handoff.rounds.length, 1);
  });
  it("backfills consumed historical rollouts without duplicating events", () => {
    rollout();
    append([
      record("event_msg", { type: "user_message", message: "Past ask" }),
      record("event_msg", { type: "agent_message", message: "Past reply" }, 2),
    ]);
    ingestCodexTranscript(file);
    const count = db.prepare("SELECT COUNT(*) n FROM events").get().n;
    const value = metadata();
    delete value.handoff;
    delete value.handoff_version;
    value.custom = "preserve";
    stmts.updateSession.run(null, null, null, JSON.stringify(value), ID);
    assert.equal(ingestCodexTranscript(file).changed, true);
    assert.equal(metadata().handoff.rounds[0].reply, "Past reply");
    assert.equal(metadata().custom, "preserve");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, count);
  });
  it("matches Windows cwd case/slashes and the active interval at Codex launch", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("parent", {
      cwd: "c:/users/MARTIN/documents/card_game/",
      status: "completed",
      end: at(3),
    });
    claude("too-late", { start: at(2) });
    claude("remote", { source: "remote:other" });
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "parent");
    assert.equal(reconcileHandoffParents().length, 0);
  });
  it("leaves ambiguous cwd matches null, including a parent imported later", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("parent");
    reconcileHandoffParents();
    claude("other");
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, null);
  });
  for (const subagent of [false, true])
    it(`links a late Bash result in a ${subagent ? "subagent" : "main"} transcript over cwd fallback`, () => {
      rollout();
      ingestCodexTranscript(file);
      claude("fallback");
      claude("actual", { cwd: "D:/elsewhere" });
      reconcileHandoffParents();
      assert.equal(metadata().handoff.parent_session_id, "fallback");
      const target = subagent
        ? path.join(project, "actual", "subagents", "agent-rescue.jsonl")
        : path.join(project, "actual.jsonl");
      bashResult(target);
      const changes = reconcileHandoffParents();
      assert.equal(changes.length, 1);
      assert.equal(changes[0].session.id, ID);
      assert.equal(metadata().handoff.parent_session_id, "actual");
      assert.equal(reconcileHandoffParents().length, 0);
    });
  it("rejects non-Bash results, plain text markers and other sources", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("not-bash", { cwd: "D:/elsewhere" });
    bashResult(path.join(project, "not-bash.jsonl"), "Read");
    claude("remote", { source: "remote:other" });
    bashResult(path.join(project, "remote.jsonl"));
    append(
      [{ message: { content: [{ type: "text", text: `Thread ready (${ID})` }] } }],
      path.join(project, "not-bash.jsonl")
    );
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, null);
  });
  it("waits for complete tool results and pairs Bash across separate append scans", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("parent", { cwd: "D:/other" });
    const target = path.join(project, "parent", "subagents", "agent-rescue.jsonl");
    append([{ message: { content: [{ type: "tool_use", id: "split", name: "Bash" }] } }], target);
    reconcileHandoffParents();
    const line = JSON.stringify({
      message: {
        content: [
          { type: "tool_result", tool_use_id: "split", content: `[codex] Thread ready (${ID}).` },
        ],
      },
    });
    fs.appendFileSync(target, line.slice(0, 70));
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, null);
    fs.appendFileSync(target, line.slice(70) + "\n");
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "parent");
  });
  it("normalizes SQLite UTC parent timestamps rather than interpreting them in local time", () => {
    rollout();
    ingestCodexTranscript(file);
    claude("parent", {
      status: "completed",
      start: "2026-10-14 10:00:00",
      end: "2026-10-14 10:02:00",
    });
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "parent");
  });
  it("recognizes explicit parents before their database row arrives", () => {
    rollout();
    ingestCodexTranscript(file);
    bashResult(path.join(project, "not-imported-yet", "subagents", "agent-rescue.jsonl"));
    reconcileHandoffParents();
    assert.equal(metadata().handoff.parent_session_id, "not-imported-yet");
  });
  it("strips Companion titles in imported session indexes too", async () => {
    rollout();
    fs.writeFileSync(
      path.join(path.dirname(file), "session_index.jsonl"),
      JSON.stringify({
        id: ID,
        thread_name: "Codex Companion Task: Imported assignment",
        updated_at: at(2),
      }) + "\n"
    );
    const { importCodexFromDirectory } = require("../lib/codex-import");
    await importCodexFromDirectory(path.dirname(file), { retainLivePath: true });
    assert.equal(stmts.getSession.get(ID).name, "Imported assignment");
  });
  it("counts distinct user messages even when timestamps or clipped prefixes coincide", () => {
    rollout();
    append([
      record("event_msg", { type: "user_message", message: "x".repeat(2000) + "A" }),
      record("event_msg", { type: "user_message", message: "x".repeat(2000) + "B" }),
    ]);
    ingestCodexTranscript(file);
    append([record("event_msg", { type: "user_message", message: "x".repeat(2000) + "B" })]);
    ingestCodexTranscript(file);
    assert.equal(metadata().handoff.rounds.length, 3);
  });
});
