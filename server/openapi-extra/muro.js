/**
 * @file OpenAPI contract for Muro summary periods, usage totals, completion
 * series, the 35-day heatmap, and the uncapped daily completion streak.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const count = { type: "integer", minimum: 0 };
const schemas = {
  MuroTotals: {
    type: "object",
    required: ["tasks_completed", "tokens", "time_worked_ms"],
    properties: {
      tasks_completed: {
        ...count,
        description: "Sessions completed in the local period, by ended_at.",
      },
      tokens: {
        ...count,
        description:
          "Effective input, output, cache-read and cache-write tokens (current + baseline) from sessions started in the period. The 1h cache-write subset is not counted twice.",
      },
      time_worked_ms: {
        type: "number",
        minimum: 0,
        description:
          "Sum for sessions started in the period: nonnegative numeric metadata.total_turn_duration_ms (including zero), otherwise ended_at (or now) minus started_at, clamped to zero.",
      },
    },
  },
  MuroSummary: {
    type: "object",
    required: ["period", "totals", "series", "heatmap", "streak_days"],
    properties: {
      period: { type: "string", enum: ["today", "7d", "30d"] },
      totals: {
        type: "object",
        required: ["claude", "codex"],
        properties: {
          claude: { $ref: "#/components/schemas/MuroTotals" },
          codex: { $ref: "#/components/schemas/MuroTotals" },
        },
      },
      series: {
        type: "object",
        required: ["unit", "buckets"],
        properties: {
          unit: { type: "string", enum: ["hour", "day"] },
          buckets: {
            type: "array",
            description:
              "Completed sessions, oldest first. Exactly 24 hourly buckets for today, or 7/30 daily buckets including today. Missing buckets, including future hours today, contain zeros.",
            items: {
              type: "object",
              required: ["bucket", "claude", "codex"],
              properties: {
                bucket: {
                  type: "string",
                  description: "Local YYYY-MM-DDTHH for hours, YYYY-MM-DD for days.",
                  example: "2026-10-13T09",
                },
                claude: count,
                codex: count,
              },
            },
          },
        },
      },
      heatmap: {
        type: "array",
        minItems: 35,
        maxItems: 35,
        description:
          "Completed sessions in the last 35 local calendar days, including today, oldest first and zero-filled. Independent of period; respects source/provider scope.",
        items: {
          type: "object",
          required: ["date", "claude", "codex"],
          properties: { date: { type: "string", format: "date" }, claude: count, codex: count },
        },
      },
      streak_days: {
        ...count,
        description:
          "Consecutive local days with a completed session through today; starts yesterday if today has none. Independent of period and not limited to the heatmap's 35 days.",
      },
    },
  },
};

module.exports = {
  tags: [{ name: "Muro", description: "Claude and Codex work summary" }],
  schemas,
  paths: {
    "/api/muro/summary": {
      get: {
        tags: ["Muro"],
        operationId: "getMuroSummary",
        summary: "Get the Muro work summary",
        description:
          "Read-only aggregates for stored Claude and Codex sessions. Cursor is always excluded, even under the Claude product scope. Tasks use completed sessions' ended_at; tokens and time use started_at for all statuses. Periods run from local midnight through the current instant; future starts/completions are excluded. One fixed tz_offset applies to all historical dates, as in Analytics.",
        parameters: [
          {
            name: "period",
            in: "query",
            schema: { type: "string", enum: ["today", "7d", "30d"], default: "today" },
            description: "Today or the last 7/30 local calendar days, including today.",
          },
          {
            name: "tz_offset",
            in: "query",
            schema: { type: "integer", minimum: -840, maximum: 720, default: 0 },
            description:
              "Minutes from Date.getTimezoneOffset(): UTC+2 sends -120. Omitted means UTC. Invalid values return 400.",
          },
          { $ref: "#/components/parameters/SourcesQuery" },
          { $ref: "#/components/parameters/ProvidersQuery" },
        ],
        responses: {
          200: {
            description: "Muro summary (both provider keys always present)",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MuroSummary" } },
            },
          },
          400: {
            description: "Invalid period or timezone offset",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
        },
      },
    },
  },
};
