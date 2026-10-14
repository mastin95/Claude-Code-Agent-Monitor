/**
 * @file Reduces Claude-origin Codex conversations and reconciles their parents
 * from cached Companion jobs and incremental Bash evidence, with a cwd fallback.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { StringDecoder } = require("string_decoder");
const { createHash } = require("crypto");
const { db, stmts } = require("../db");
const { getProjectsDir, getClaudeHome } = require("./claude-home");

function metadataOf(session) {
  try {
    const value = JSON.parse(session?.metadata || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
const textOf = (value) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => part?.text || "").join("\n")
      : "";
const clip = (value) => Array.from(textOf(value)).slice(0, 2000).join("");

/** Mirrored event/response prompts are one round, even across ingest windows. */
function reduceHandoff(handoff, record, cursor = {}) {
  const payload = record.payload || {};
  if (record.type === "session_meta" && payload.originator === "Claude Code") {
    return handoff || { from: "claude", parent_session_id: null, rounds: [] };
  }
  if (!handoff) return null;
  const isEvent = record.type === "event_msg";
  const isUserItem =
    record.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user" &&
    payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes("user.text");
  const at = Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null;
  const last = handoff.rounds.at(-1);
  if ((isEvent && payload.type === "user_message") || isUserItem) {
    const raw = textOf(isUserItem ? payload.content : payload.message);
    const ask = clip(raw);
    const key = createHash("sha256").update(raw).digest("hex");
    const turn = payload.turn_id || payload.internal_chat_message_metadata_passthrough?.turn_id;
    const mirrored =
      last &&
      !cursor.paired &&
      cursor.source !== record.type &&
      cursor.key === key &&
      ((turn && cursor.turn === turn) || (at && cursor.at === at));
    if (!mirrored) {
      handoff.rounds.push({ ask, ask_at: at, reply: null, reply_at: null });
      Object.assign(cursor, {
        source: record.type,
        key,
        turn: turn || null,
        at,
        paired: false,
        replyPriority: 0,
      });
    } else {
      cursor.paired = true;
    }
  } else if (last) {
    // item_completed is a mirror, never an additional prompt or reply.
    const assistant =
      record.type === "response_item" && payload.type === "message" && payload.role === "assistant";
    const complete =
      isEvent && payload.type === "task_complete" && typeof payload.last_agent_message === "string";
    const legacy = isEvent && payload.type === "agent_message";
    const priority = complete ? 3 : assistant && payload.phase === "final_answer" ? 2 : 1;
    if ((assistant || complete || legacy) && priority >= (cursor.replyPriority || 0)) {
      last.reply = clip(
        complete ? payload.last_agent_message : assistant ? payload.content : payload.message
      );
      last.reply_at = at;
      cursor.replyPriority = priority;
    }
  }
  return handoff;
}

function saveHandoff(sessionId, handoff, evidence) {
  const metadata = metadataOf(stmts.getSession.get(sessionId));
  if (
    JSON.stringify(metadata.handoff) === JSON.stringify(handoff) &&
    (!evidence || metadata.handoff_parent_evidence === evidence)
  )
    return false;
  metadata.handoff = handoff;
  if (evidence) metadata.handoff_parent_evidence = evidence;
  stmts.updateSession.run(null, null, null, JSON.stringify(metadata), sessionId);
  return true;
}

function handoffTitle(session, title) {
  return metadataOf(session).handoff?.from === "claude"
    ? title?.replace(/^Codex Companion Task: /, "")
    : title;
}

// One cursor per Claude transcript. Never reread unchanged history on the 4s sweep.
// Tool ids and matches survive append boundaries; truncated/replaced files reset.
const files = new Map();
function scanFile(file, parentId) {
  try {
    const stat = fs.statSync(file);
    let state = files.get(file);
    if (
      !state ||
      state.ino !== stat.ino ||
      stat.size < state.offset ||
      (stat.size === state.offset && stat.mtimeMs !== state.mtime)
    ) {
      state = {
        offset: 0,
        ino: stat.ino,
        mtime: 0,
        tail: "",
        decoder: new StringDecoder("utf8"),
        bash: new Set(),
        results: new Map(),
        ids: new Set(),
      };
      files.set(file, state);
    }
    state.parentId = parentId;
    if (state.offset === stat.size) return state;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      while (state.offset < stat.size) {
        const length = fs.readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, stat.size - state.offset),
          state.offset
        );
        if (!length) break;
        state.offset += length;
        const lines = (state.tail + state.decoder.write(buffer.subarray(0, length))).split("\n");
        state.tail = lines.pop();
        for (const line of lines) {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
            if (block.type === "tool_use" && block.name === "Bash" && typeof block.id === "string")
              state.bash.add(block.id);
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              const matches = [
                ...textOf(block.content).matchAll(/Thread ready \(([0-9a-f-]+)\)/gi),
              ].map((match) => match[1]);
              if (matches.length) state.results.set(block.tool_use_id, matches);
            }
          }
        }
      }
      for (const [id, matches] of state.results) {
        if (state.bash.has(id)) for (const match of matches) state.ids.add(match);
      }
      state.mtime = stat.mtimeMs;
    } finally {
      fs.closeSync(fd);
    }
    return state;
  } catch {
    return null;
  }
}

function transcriptFiles(root, parentId, found) {
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const relative = path.relative(root, file).split(path.sep);
        const subagents = relative.indexOf("subagents");
        const owner =
          parentId || (subagents > 0 ? relative[subagents - 1] : path.basename(file, ".jsonl"));
        found.set(file, owner);
      }
    }
  }
}

const normalizedCwd = (cwd) =>
  typeof cwd === "string" ? cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : null;
// SQLite stores UTC timestamps without a zone; Date.parse otherwise treats
// them as local time on Windows, shifting which parent was active at launch.
const timestampMs = (value) =>
  Date.parse(
    typeof value === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
      ? value.replace(" ", "T") + "Z"
      : value
  );

function defaultJobRoots() {
  return [
    path.join(
      process.env.CLAUDE_PLUGIN_DATA ||
        path.join(getClaudeHome(), "plugins", "data", "codex-openai-codex"),
      "state"
    ),
    path.join(os.tmpdir(), "codex-companion"),
  ];
}

const jobFiles = new Map();
function directoryEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Only workspace/jobs/*.json; never walk arbitrary plugin state or workspaces.
function scanJobs(roots) {
  const seen = new Set();
  const evidence = new Map();
  for (const root of roots) {
    for (const workspace of directoryEntries(root)) {
      if (!workspace.isDirectory()) continue;
      const dir = path.join(root, workspace.name, "jobs");
      for (const entry of directoryEntries(dir)) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(dir, entry.name);
        seen.add(file);
        try {
          const stat = fs.statSync(file);
          let cached = jobFiles.get(file);
          if (
            !cached ||
            cached.mtime !== stat.mtimeMs ||
            cached.size !== stat.size ||
            cached.ino !== stat.ino
          ) {
            cached = {
              mtime: stat.mtimeMs,
              size: stat.size,
              ino: stat.ino,
              job: JSON.parse(fs.readFileSync(file, "utf8")),
            };
            jobFiles.set(file, cached);
          }
          const job = cached.job;
          if (
            typeof job?.threadId !== "string" ||
            !job.threadId ||
            typeof job.sessionId !== "string" ||
            !job.sessionId
          )
            continue;
          if (!evidence.has(job.threadId)) evidence.set(job.threadId, new Set());
          evidence.get(job.threadId).add(job.sessionId);
        } catch {
          /* Missing or partially written jobs are retried on the next sweep. */
        }
      }
    }
  }
  for (const file of jobFiles.keys()) if (!seen.has(file)) jobFiles.delete(file);
  return evidence;
}

/** Called independently of Codex byte changes so late Claude results also publish. */
function reconcileHandoffParents({ jobRoots = defaultJobRoots() } = {}) {
  const codex = db
    .prepare(
      "SELECT * FROM sessions WHERE provider = 'codex' AND json_valid(metadata) AND json_extract(metadata, '$.handoff.from') = 'claude'"
    )
    .all();
  if (!codex.length) return [];
  const jobs = scanJobs(jobRoots);
  const claude = db.prepare("SELECT * FROM sessions WHERE provider = 'claude'").all();
  const byId = new Map(claude.map((session) => [session.id, session]));
  const paths = new Map();
  transcriptFiles(getProjectsDir(), null, paths);
  for (const session of claude) {
    if (!session.transcript_path) continue;
    paths.set(session.transcript_path, session.id);
    transcriptFiles(
      path.join(path.dirname(session.transcript_path), session.id, "subagents"),
      session.id,
      paths
    );
  }
  const evidence = new Map();
  for (const [file, parentId] of paths) {
    const state = scanFile(file, parentId);
    for (const id of state?.ids || []) {
      if (!evidence.has(id)) evidence.set(id, new Set());
      evidence.get(id).add(parentId);
    }
  }
  // Bound caches to discoverable files; evidence already persisted in metadata survives pruning.
  for (const file of files.keys()) if (!paths.has(file)) files.delete(file);
  const changed = [];
  for (const session of codex) {
    const metadata = metadataOf(session);
    const handoff = metadata.handoff;
    const sameSource = (candidate) => candidate.source === session.source;
    // A local transcript can precede its parent DB row. Its filename still
    // identifies the parent; remote snapshots have a known source owner.
    const explicit = [...(evidence.get(session.id) || [])].filter(
      (id) => (byId.get(id)?.source || "local") === (session.source || "local")
    );
    const start = timestampMs(session.started_at);
    const candidates = claude.filter(
      (candidate) =>
        sameSource(candidate) &&
        normalizedCwd(session.cwd) &&
        normalizedCwd(candidate.cwd) === normalizedCwd(session.cwd) &&
        timestampMs(candidate.started_at) <= start &&
        (candidate.ended_at
          ? timestampMs(candidate.ended_at) >= start
          : candidate.status === "active")
    );
    const jobParents =
      session.source === "local" || !session.source ? [...(jobs.get(session.id) || [])] : [];
    const parent = jobParents.length
      ? jobParents.length === 1
        ? jobParents[0]
        : null
      : metadata.handoff_parent_evidence === "job"
        ? handoff.parent_session_id
        : explicit.length
          ? explicit.length === 1
            ? explicit[0]
            : null
          : metadata.handoff_parent_evidence === "transcript"
            ? handoff.parent_session_id
            : candidates.length === 1
              ? candidates[0].id
              : null;
    const evidenceKind =
      jobParents.length || metadata.handoff_parent_evidence === "job"
        ? "job"
        : explicit.length
          ? "transcript"
          : metadata.handoff_parent_evidence === "transcript"
            ? "transcript"
            : "cwd";
    if (saveHandoff(session.id, { ...handoff, parent_session_id: parent }, evidenceKind)) {
      changed.push({
        changed: true,
        created: false,
        session: stmts.getSession.get(session.id),
        events: [],
      });
    }
  }
  return changed;
}

module.exports = { metadataOf, reduceHandoff, saveHandoff, handoffTitle, reconcileHandoffParents };
