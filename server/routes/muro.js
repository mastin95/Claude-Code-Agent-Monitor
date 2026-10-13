/**
 * @file Read-only Muro summary endpoint with validated calendar periods and
 * timezone offsets, sharing the dashboard's source and provider filters.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { db } = require("../db");
const { parseSources } = require("../lib/source-filter");
const { parseProviders } = require("../lib/provider-filter");
const { muroSummary } = require("../lib/muro-summary");

const router = Router();

router.get("/summary", (req, res) => {
  const period = req.query.period ?? "today";
  if (!["today", "7d", "30d"].includes(period)) {
    return res.status(400).json({
      error: { code: "INVALID_PERIOD", message: "period must be today, 7d, or 30d" },
    });
  }

  // Same sign convention as /api/analytics: UTC+2 sends -120.
  const rawOffset = req.query.tz_offset ?? "0";
  const tzOffset = typeof rawOffset === "string" ? Number(rawOffset) : NaN;
  if (
    typeof rawOffset !== "string" ||
    !/^[+-]?\d+$/.test(rawOffset) ||
    !Number.isInteger(tzOffset) ||
    tzOffset < -840 ||
    tzOffset > 720
  ) {
    return res.status(400).json({
      error: {
        code: "INVALID_TZ_OFFSET",
        message: "tz_offset must be an integer between -840 and 720 minutes",
      },
    });
  }

  res.json(muroSummary(db, parseSources(req), parseProviders(req), period, tzOffset));
});

module.exports = router;
