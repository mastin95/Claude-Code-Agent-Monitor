/**
 * @file Computes Muro aggregates for Claude and Codex sessions using the shared
 * source/provider scope, local calendar periods, and effective token counts.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { sessionScope } = require("./scoped-stats");

const DAY_MS = 86_400_000;
const PERIOD_DAYS = { today: 1, "7d": 7, "30d": 30 };

/** Build a consistent summary at one instant; offsets follow getTimezoneOffset(). */
function muroSummary(db, sources, providers, period, tzOffset, now = Date.now()) {
  const offsetMs = tzOffset * 60_000;
  const today = new Date(now - offsetMs).toISOString().slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const days = PERIOD_DAYS[period];
  const start = midnight - (days - 1) * DAY_MS;
  const startUtc = new Date(start + offsetMs).toISOString();
  const nowUtc = new Date(now).toISOString();
  const modifier = `${-tzOffset} minutes`;
  const dateAt = (day) => new Date(day).toISOString().slice(0, 10);

  const scope = sessionScope(sources, providers, "s");
  // parseProviders expands Claude to include Cursor elsewhere in the app.
  // Keep this intersection explicit, including for a Cursor-only scope.
  const where = `${scope.where || "WHERE 1 = 1"} AND s.provider IN ('claude', 'codex')`;
  const totals = {
    claude: { tasks_completed: 0, tokens: 0, time_worked_ms: 0 },
    codex: { tasks_completed: 0, tokens: 0, time_worked_ms: 0 },
  };

  // Attribute usage and duration to started_at. Sum tokens per session before
  // summing durations: multiple models/rate buckets must not multiply time.
  // The 1h cache-write counter is a subset, and server-tool counts are not tokens.
  const usage = db
    .prepare(
      `WITH selected AS (
        SELECT s.*,
          CASE WHEN json_valid(s.metadata)
            THEN CASE WHEN json_type(s.metadata, '$.total_turn_duration_ms') IN ('integer', 'real')
              THEN json_extract(s.metadata, '$.total_turn_duration_ms') END END AS turn_ms
        FROM sessions s ${where}
          AND julianday(s.started_at) >= julianday(?)
          AND julianday(s.started_at) <= julianday(?)
      )
      SELECT s.provider,
        SUM((SELECT COALESCE(SUM(
          input_tokens + baseline_input + output_tokens + baseline_output +
          cache_read_tokens + baseline_cache_read + cache_write_tokens + baseline_cache_write
        ), 0) FROM token_usage tu WHERE tu.session_id = s.id)) AS tokens,
        SUM(CASE WHEN typeof(s.turn_ms) IN ('integer', 'real') AND s.turn_ms >= 0
          THEN s.turn_ms
          ELSE COALESCE(MAX(0, ROUND((julianday(COALESCE(s.ended_at, ?)) -
            julianday(s.started_at)) * 86400000)), 0)
        END) AS time_worked_ms
      FROM selected s GROUP BY s.provider`
    )
    .all(...scope.params, startUtc, nowUtc, nowUtc);
  for (const row of usage) {
    totals[row.provider].tokens = row.tokens;
    totals[row.provider].time_worked_ms = row.time_worked_ms;
  }

  // Keep all completed days for the streak: it is not capped by the selected
  // period or the 35-day heatmap. Only aggregated daily counts leave SQLite.
  const completed = db
    .prepare(
      `SELECT DATE(s.ended_at, ?) AS date, s.provider, COUNT(*) AS count
       FROM sessions s ${where} AND s.status = 'completed'
         AND julianday(s.ended_at) <= julianday(?)
       GROUP BY date, s.provider`
    )
    .all(modifier, ...scope.params, nowUtc);
  const byDate = new Map();
  const startDate = dateAt(start);
  for (const row of completed) {
    if (!byDate.has(row.date)) byDate.set(row.date, { claude: 0, codex: 0 });
    byDate.get(row.date)[row.provider] = row.count;
    if (row.date >= startDate && row.date <= today) {
      totals[row.provider].tasks_completed += row.count;
    }
  }

  const countsAt = (date) => byDate.get(date) || { claude: 0, codex: 0 };
  const heatmap = Array.from({ length: 35 }, (_, i) => {
    const date = dateAt(midnight - (34 - i) * DAY_MS);
    return { date, ...countsAt(date) };
  });
  let streakDays = 0;
  let streakDay = midnight;
  if (!byDate.has(today)) streakDay -= DAY_MS;
  while (byDate.has(dateAt(streakDay))) {
    streakDays++;
    streakDay -= DAY_MS;
  }

  let buckets;
  if (period === "today") {
    buckets = Array.from({ length: 24 }, (_, hour) => ({
      bucket: `${today}T${String(hour).padStart(2, "0")}`,
      claude: 0,
      codex: 0,
    }));
    const hourly = db
      .prepare(
        `SELECT CAST(strftime('%H', s.ended_at, ?) AS INTEGER) AS hour,
          s.provider, COUNT(*) AS count
         FROM sessions s ${where} AND s.status = 'completed'
           AND julianday(s.ended_at) >= julianday(?)
           AND julianday(s.ended_at) <= julianday(?)
         GROUP BY hour, s.provider`
      )
      .all(modifier, ...scope.params, startUtc, nowUtc);
    for (const row of hourly) buckets[row.hour][row.provider] = row.count;
  } else {
    buckets = Array.from({ length: days }, (_, i) => {
      const bucket = dateAt(start + i * DAY_MS);
      return { bucket, ...countsAt(bucket) };
    });
  }

  return {
    period,
    totals,
    series: { unit: period === "today" ? "hour" : "day", buckets },
    heatmap,
    streak_days: streakDays,
  };
}

module.exports = { muroSummary };
