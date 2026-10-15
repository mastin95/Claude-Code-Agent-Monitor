/**
 * @file Project-only Monitor tests: hooks may create sessions only inside a Dirección
 *   project's folder after it was created, and `?project=<id>` narrows the scoped read
 *   routes (sessions, stats, analytics, agents, events, Muro) to that project's sessions.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "project-scope-test-"));
process.env.DASHBOARD_DB_PATH = path.join(tmp, "dashboard.db");
process.env.DASHBOARD_DATA_DIR = path.join(tmp, "data");
process.env.DASHBOARD_LIVENESS_PROBE = "0";
process.env.DASHBOARD_PROJECT_ONLY = "1";

const { createApp } = require("../index");
const { db } = require("../db");
const scope = require("../lib/project-scope");

const CREATED = "2026-10-15T10:00:00.000Z";
let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  db.exec("DELETE FROM events; DELETE FROM agents; DELETE FROM sessions;");
  db.exec("DELETE FROM conductor_projects");
  db.prepare(
    `INSERT INTO conductor_projects (id, cwd, name, lead, created_at)
     VALUES ('card', 'C:\\Users\\Martin\\Documents\\Card_Game', 'Card_Game', 'claude', ?),
            ('other', '/home/martin/other', 'Other', 'claude', ?)`
  ).run(CREATED, CREATED);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(id, cwd, startedAt, provider = "claude") {
  db.prepare(
    `INSERT INTO sessions (id, name, status, cwd, provider, started_at, updated_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?)`
  ).run(id, id, cwd, provider, startedAt, startedAt);
  db.prepare(
    "INSERT INTO agents (id, session_id, name, type, status) VALUES (?, ?, 'Main', 'main', 'completed')"
  ).run(`${id}-main`, id);
  db.prepare("INSERT INTO events (session_id, event_type, summary) VALUES (?, 'Stop', 'done')").run(
    id
  );
}

async function get(url) {
  const res = await fetch(`${base}${url}`);
  assert.equal(res.status, 200, url);
  return res.json();
}

test("admitsNewSession: project folders and sub-folders, case and slash blind, after creation", () => {
  const admits = (cwd, at = "2026-10-15T11:00:00.000Z") => scope.admitsNewSession(cwd, at, db);
  assert.equal(admits("C:\\Users\\Martin\\Documents\\Card_Game"), true);
  assert.equal(admits("c:/users/martin/documents/card_game/src/"), true);
  assert.equal(admits("C:\\Users\\Martin\\Documents\\Card_Game2"), false);
  assert.equal(
    admits("C:\\Users\\Martin\\Documents\\Card_Game", "2026-10-14T09:00:00.000Z"),
    false
  );
  assert.equal(admits("/home/martin"), false);
  assert.equal(admits(null), false);
  process.env.DASHBOARD_PROJECT_ONLY = "0";
  try {
    assert.equal(admits("/anywhere"), true);
  } finally {
    process.env.DASHBOARD_PROJECT_ONLY = "1";
  }
});

test("hooks outside a project are acknowledged and dropped; inside they create the session", async () => {
  const post = (data) =>
    fetch(`${base}/api/hooks/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_type: "SessionStart", data }),
    }).then((res) => res.json());
  const outside = await post({ session_id: "out-1", cwd: "/tmp/elsewhere" });
  assert.equal(outside.skipped, "outside_project");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  const inside = await post({ session_id: "in-1", cwd: "/home/martin/other/app" });
  assert.equal(inside.ok, true);
  assert.equal(inside.skipped, undefined);
  assert.ok(db.prepare("SELECT id FROM sessions WHERE id = 'in-1'").get());
});

test("?project= narrows sessions, stats, analytics, agents, events and Muro to the project", async () => {
  seed("card-new", "C:\\Users\\Martin\\Documents\\Card_Game", "2026-10-15T12:00:00.000Z");
  seed("card-sub", "C:/Users/Martin/Documents/Card_Game/web", "2026-10-15T13:00:00.000Z", "codex");
  seed("card-old", "C:\\Users\\Martin\\Documents\\Card_Game", "2026-10-01T12:00:00.000Z");
  seed("elsewhere", "/home/martin/other", "2026-10-15T12:00:00.000Z");
  seed("legacy", "/home/martin/legacy", "2026-09-01T12:00:00.000Z");

  const sessions = await get("/api/sessions?project=card&limit=50");
  assert.deepEqual(sessions.sessions.map((s) => s.id).sort(), ["card-new", "card-sub"]);
  const codexOnly = await get("/api/sessions?project=card&providers=codex");
  assert.deepEqual(
    codexOnly.sessions.map((s) => s.id),
    ["card-sub"]
  );
  const stats = await get("/api/stats?project=card");
  assert.equal(stats.total_sessions, 2);
  assert.equal(stats.total_events, 2);
  const analytics = await get("/api/analytics?project=card");
  assert.equal(analytics.overview.total_sessions, 2);
  const agents = await get("/api/agents?project=card&limit=50");
  assert.deepEqual(agents.agents.map((a) => a.session_id).sort(), ["card-new", "card-sub"]);
  const events = await get("/api/events?project=card&limit=50");
  assert.deepEqual(events.events.map((e) => e.session_id).sort(), ["card-new", "card-sub"]);
  const facets = await get("/api/sessions/facets?project=card");
  assert.equal(facets.cwds.length, 2);
  await get("/api/muro/summary?project=card&period=30d");
  await get("/api/workflows?project=card");
  await get("/api/pricing/cost?project=card");

  const unknown = await get("/api/sessions?project=nope");
  assert.equal(unknown.sessions.length, 0);
  const all = await get("/api/stats");
  assert.equal(all.total_sessions, 5);
  const detail = await fetch(`${base}/api/sessions/legacy?project=card`);
  assert.equal(detail.status, 404);
});
