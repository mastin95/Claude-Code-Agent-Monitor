/**
 * @file Integration tests for Muro's mounted summary endpoint: local calendar
 * boundaries, effective usage, zero-filled charts, scopes, and completion streaks.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "muro-test-"));
process.env.DASHBOARD_DB_PATH = path.join(tmp, "dashboard.db");
process.env.DASHBOARD_DATA_DIR = path.join(tmp, "data");
process.env.DASHBOARD_LIVENESS_PROBE = "0";

const { createApp } = require("../index");
const { db } = require("../db");
const NOW = Date.parse("2026-10-13T12:34:56.789Z");
const DAY = 86_400_000;
const MIDNIGHT = Date.parse("2026-10-13T00:00:00Z");
let server;
let base;
let serial = 0;

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach((t) => {
  t.mock.method(Date, "now", () => NOW);
  db.exec("DELETE FROM sessions");
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function iso(ms) {
  return new Date(ms).toISOString();
}

function session({
  provider = "claude",
  source = "local",
  status = "completed",
  start = MIDNIGHT + 3_600_000,
  end = MIDNIGHT + 7_200_000,
  metadata = { total_turn_duration_ms: 0 },
} = {}) {
  const id = `muro-${++serial}`;
  db.prepare(
    `INSERT INTO sessions
    (id, provider, source, status, started_at, ended_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    provider,
    source,
    status,
    typeof start === "number" ? iso(start) : start,
    typeof end === "number" ? iso(end) : end,
    typeof metadata === "string" ? metadata : JSON.stringify(metadata)
  );
  return id;
}

function tokens(id, model = "test", input = 1) {
  db.prepare(
    `INSERT INTO token_usage
    (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     baseline_input, baseline_output, baseline_cache_read, baseline_cache_write,
     cache_write_1h_tokens, baseline_cache_write_1h, web_search_requests)
    VALUES (?, ?, ?, 2, 3, 4, 10, 20, 30, 40, 4, 40, 999)`
  ).run(id, model, input);
}

async function summary(query = "") {
  const response = await fetch(`${base}/api/muro/summary${query ? `?${query}` : ""}`);
  assert.equal(response.status, 200);
  return response.json();
}

const ZERO = { tasks_completed: 0, tokens: 0, time_worked_ms: 0 };
function assertZero(result) {
  assert.deepEqual(result.totals, { claude: ZERO, codex: ZERO });
  assert.equal(result.streak_days, 0);
  for (const row of [...result.series.buckets, ...result.heatmap]) {
    assert.equal(row.claude, 0);
    assert.equal(row.codex, 0);
  }
}

describe("GET /api/muro/summary", () => {
  for (const [period, days] of [
    ["today", 1],
    ["7d", 7],
    ["30d", 30],
  ]) {
    it(`zero-fills an empty ${period} window and the 35-day heatmap`, async () => {
      const result = await summary(`period=${period}`);
      assert.equal(result.period, period);
      assert.equal(result.series.unit, period === "today" ? "hour" : "day");
      assert.equal(result.series.buckets.length, period === "today" ? 24 : days);
      assert.equal(
        result.series.buckets[0].bucket,
        period === "today" ? "2026-10-13T00" : iso(MIDNIGHT - (days - 1) * DAY).slice(0, 10)
      );
      assert.equal(
        result.series.buckets.at(-1).bucket,
        period === "today" ? "2026-10-13T23" : "2026-10-13"
      );
      assert.equal(result.heatmap.length, 35);
      assert.equal(result.heatmap[0].date, "2026-09-09");
      assert.equal(result.heatmap.at(-1).date, "2026-10-13");
      assertZero(result);
    });

    it(`uses inclusive local midnight and excludes earlier/future sessions for ${period}`, async () => {
      const start = MIDNIGHT - (days - 1) * DAY;
      tokens(session({ start, end: start }));
      tokens(session({ start: start - 1, end: start - 1 }));
      tokens(session({ start: NOW, end: NOW, provider: "codex" }));
      tokens(session({ start: NOW + 1, end: NOW + 1 }));
      // An older session finishing now counts as a task, but its usage belongs
      // to the period in which it started.
      tokens(session({ start: start - DAY, end: NOW }));
      const result = await summary(`period=${period}`);
      assert.deepEqual(result.totals.claude, {
        tasks_completed: 2,
        tokens: 110,
        time_worked_ms: 0,
      });
      assert.deepEqual(result.totals.codex, { tasks_completed: 1, tokens: 110, time_worked_ms: 0 });
      for (const provider of ["claude", "codex"]) {
        assert.equal(
          result.series.buckets.reduce((sum, row) => sum + row[provider], 0),
          result.totals[provider].tasks_completed
        );
      }
      assert.ok(result.series.buckets.some((row) => row.claude === 0 && row.codex === 0));
    });
  }

  it("defaults to today/UTC and sums every token bucket without multiplying duration", async () => {
    const id = session({ metadata: { total_turn_duration_ms: 1500 } });
    tokens(id);
    tokens(id, "other-model", 11);
    db.prepare(
      "INSERT INTO agents (id, session_id, name, type, status) VALUES (?, ?, ?, ?, ?)"
    ).run("child", id, "Child", "subagent", "completed");
    const result = await summary();
    assert.equal(result.period, "today");
    assert.deepEqual(result.totals.claude, {
      tasks_completed: 1,
      tokens: 230,
      time_worked_ms: 1500,
    });
    assert.deepEqual(result.series.buckets[2], { bucket: "2026-10-13T02", claude: 1, codex: 0 });
  });

  it("counts usage for active/error/abandoned sessions and handles duration fallbacks", async () => {
    tokens(session({ status: "active", start: NOW - 1234, end: null, metadata: null }));
    tokens(session({ status: "error", metadata: { total_turn_duration_ms: 50 } }));
    tokens(
      session({ status: "abandoned", start: NOW - 5000, end: NOW - 2000, metadata: "invalid JSON" })
    );
    session({ metadata: { total_turn_duration_ms: 0 } });
    const result = await summary();
    assert.deepEqual(result.totals.claude, {
      tasks_completed: 1,
      tokens: 330,
      time_worked_ms: 4284,
    });
  });

  it("falls back for invalid duration values and clamps reversed dates to zero", async () => {
    for (const value of [-1, "200", true, null, {}]) {
      session({ start: NOW - 2000, end: NOW - 1000, metadata: { total_turn_duration_ms: value } });
    }
    session({ start: NOW - 1000, end: NOW - 2000, metadata: {} });
    session({ start: "invalid", end: null, metadata: null });
    const result = await summary();
    assert.equal(result.totals.claude.time_worked_ms, 5000);
  });

  for (const [offset, midnight] of [
    [-120, "2026-10-12T22:00:00Z"],
    [420, "2026-10-13T07:00:00Z"],
    [-345, "2026-10-12T18:15:00Z"],
  ]) {
    it(`buckets by local midnight with tz_offset=${offset}`, async () => {
      const start = Date.parse(midnight);
      tokens(session({ start, end: start }));
      tokens(session({ start: start - 1, end: start - 1 }));
      const result = await summary(`tz_offset=${offset}`);
      assert.equal(result.totals.claude.tokens, 110);
      assert.equal(result.totals.claude.tasks_completed, 1);
      assert.equal(result.series.buckets[0].claude, 1);
      assert.equal(result.series.buckets[0].bucket, "2026-10-13T00");
      assert.equal(result.heatmap.at(-1).claude, 1);
      assert.equal(result.heatmap.at(-2).claude, 1);
      assert.equal(result.streak_days, 2);
      for (const [period, days] of [
        ["7d", 7],
        ["30d", 30],
      ]) {
        tokens(
          session({
            start: start - (days - 1) * DAY,
            end: start - (days - 1) * DAY,
            provider: "codex",
          })
        );
        tokens(
          session({
            start: start - (days - 1) * DAY - 1,
            end: start - (days - 1) * DAY - 1,
            provider: "codex",
          })
        );
        const ranged = await summary(`period=${period}&tz_offset=${offset}`);
        assert.equal(ranged.totals.codex.tokens, days === 7 ? 110 : 330);
        assert.equal(ranged.series.buckets[0].codex, 1);
        assert.equal(ranged.series.buckets[0].bucket, days === 7 ? "2026-10-07" : "2026-09-14");
      }
    });
  }

  it("derives today's date from the viewer's clock across a UTC date boundary", async (t) => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-13T00:30:00Z"));
    session({ start: Date.parse("2026-10-12T23:00:00Z"), end: Date.parse("2026-10-13T00:00:00Z") });
    const result = await summary("tz_offset=420");
    assert.equal(result.series.buckets[17].bucket, "2026-10-12T17");
    assert.equal(result.series.buckets[17].claude, 1);
    assert.equal(result.heatmap.at(-1).date, "2026-10-12");
    assert.equal(result.streak_days, 1);
  });

  it("accepts SQLite and ISO timestamp formats with the same UTC meaning", async () => {
    session({ start: "2026-10-13 01:00:00", end: "2026-10-13 02:00:00", metadata: {} });
    session({ start: "2026-10-13T03:00:00+02:00", end: "2026-10-13T04:00:00+02:00", metadata: {} });
    const result = await summary();
    assert.equal(result.series.buckets[2].claude, 2);
    assert.equal(result.totals.claude.time_worked_ms, 7_200_000);
  });

  it("keeps the streak independent of period and longer than the heatmap", async () => {
    for (let i = 0; i < 40; i++) session({ start: MIDNIGHT - i * DAY, end: MIDNIGHT - i * DAY });
    for (const period of ["today", "7d", "30d"]) {
      const result = await summary(`period=${period}`);
      assert.equal(result.streak_days, 40);
      assert.equal(result.heatmap.length, 35);
      assert.ok(result.heatmap.every((row) => row.claude === 1));
    }
  });

  it("starts the streak yesterday when today has no completed tasks and stops at gaps", async () => {
    session({ end: MIDNIGHT - DAY, provider: "claude" });
    session({ end: MIDNIGHT - 2 * DAY, provider: "codex" });
    session({ end: MIDNIGHT - 4 * DAY });
    session({ status: "error", end: MIDNIGHT });
    session({ provider: "cursor", end: MIDNIGHT });
    session({ end: NOW + 1 });
    const result = await summary();
    assert.equal(result.streak_days, 2);
    assert.equal(result.heatmap.at(-1).claude, 0);
    assert.equal(result.totals.claude.tasks_completed, 0);
    const weekly = await summary("period=7d");
    assert.deepEqual(
      weekly.series.buckets.find((row) => row.bucket === "2026-10-10"),
      { bucket: "2026-10-10", claude: 0, codex: 0 }
    );
  });

  it("returns no streak when both today and yesterday are empty", async () => {
    session({ end: MIDNIGHT - 2 * DAY });
    assert.equal((await summary()).streak_days, 0);
  });

  it("composes source/provider filters on all metrics and never includes Cursor", async () => {
    for (const provider of ["claude", "codex", "cursor"]) {
      for (const source of ["local", "remote"]) {
        tokens(session({ provider, source, metadata: { total_turn_duration_ms: 500 } }));
        session({ provider, source, start: MIDNIGHT - DAY, end: MIDNIGHT - DAY });
      }
    }
    const all = await summary();
    assert.deepEqual(Object.keys(all.totals), ["claude", "codex"]);
    assert.equal(all.totals.claude.tasks_completed, 2);
    session({ source: "local", start: MIDNIGHT - 2 * DAY, end: MIDNIGHT - 2 * DAY });
    assert.equal((await summary()).streak_days, 3);
    assert.equal((await summary("providers=codex")).streak_days, 2);
    for (const provider of ["claude", "codex"]) {
      const result = await summary(`sources=remote&providers=${provider}`);
      const other = provider === "claude" ? "codex" : "claude";
      assert.deepEqual(result.totals[provider], {
        tasks_completed: 1,
        tokens: 110,
        time_worked_ms: 500,
      });
      assert.deepEqual(result.totals[other], ZERO);
      assert.equal(result.series.buckets[2][provider], 1);
      assert.equal(result.heatmap.at(-1)[provider], 1);
      assert.equal(result.heatmap.at(-2)[provider], 1);
      assert.ok(result.heatmap.every((row) => row[other] === 0));
      assert.equal(result.streak_days, 2);
    }
    assertZero(await summary("providers=cursor"));
    assertZero(await summary("sources=missing"));
    assertZero(await summary(`sources=${encodeURIComponent("local') OR 1=1 --")}`));
  });

  it("validates period and timezone input with structured errors", async () => {
    for (const [query, code] of [
      ["period=week", "INVALID_PERIOD"],
      ["period=", "INVALID_PERIOD"],
      ["period=today&period=7d", "INVALID_PERIOD"],
      ...["nope", "", "1.5", "Infinity", "721", "-841", "0x10", "120junk"].map((value) => [
        `tz_offset=${value}`,
        "INVALID_TZ_OFFSET",
      ]),
      ["tz_offset=0&tz_offset=120", "INVALID_TZ_OFFSET"],
      ["tz_offset[toString]=bad", "INVALID_TZ_OFFSET"],
    ]) {
      const response = await fetch(`${base}/api/muro/summary?${query}`);
      assert.equal(response.status, 400, query);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.equal(typeof body.error.message, "string");
    }
  });

  it("publishes the route, all query parameters, and its response schema", async () => {
    const response = await fetch(`${base}/api/openapi.json`);
    const spec = await response.json();
    const route = spec.paths["/api/muro/summary"].get;
    assert.equal(route.operationId, "getMuroSummary");
    assert.equal(route.parameters.length, 4);
    assert.deepEqual(spec.components.schemas.MuroSummary.required, [
      "period",
      "totals",
      "series",
      "heatmap",
      "streak_days",
    ]);
    assert.equal(spec.components.schemas.MuroSummary.properties.heatmap.minItems, 35);
  });
});
