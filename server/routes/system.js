/**
 * @file System routes: identify the running server (pid, commit, start time)
 * and let a local caller restart it in place after an update. Restart is
 * loopback-only and same-origin-guarded; the server relaunches itself, so no
 * outside process has to kill it (see server/lib/self-restart.js).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const path = require("path");
const { __sameOriginGuard: sameOriginGuard } = require("./run");
const selfRestart = require("../lib/self-restart");
const { getDataDir } = require("../lib/claude-home");
const claudeRuns = require("../lib/run-spawner");
const codexRuns = require("../lib/codex-run-spawner");

const router = Router();
router.use(sameOriginGuard);

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return typeof addr === "string" && LOOPBACK_ADDRS.has(addr);
}

// Restarting kills agent runs the server spawned (Dirección, Run), so a busy
// server refuses unless the caller passes { "force": true }.
function liveRunCount(req) {
  const injected = req.app?.locals?.liveRunCount;
  if (typeof injected === "function") return injected();
  return claudeRuns.liveCount() + codexRuns.liveCount();
}

function restarter(req) {
  const injected = req.app?.locals?.selfRestart;
  return injected && typeof injected.requestRestart === "function" ? injected : selfRestart;
}

router.get("/instance", (req, res) => {
  res.json(restarter(req).describeInstance());
});

router.post("/restart", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({
      error: { code: "ENOTLOCAL", message: "restart is only allowed from this computer" },
    });
  }
  const busy = liveRunCount(req);
  if (busy > 0 && req.body?.force !== true) {
    return res.status(409).json({
      error: {
        code: "EBUSY",
        message: `${busy} agent run(s) still working; retry later or pass force`,
        activeCount: busy,
      },
    });
  }
  const r = restarter(req);
  try {
    const result = await r.requestRestart({
      logFile: path.join(getDataDir(), "server-restart.log"),
    });
    res.status(202).json({ status: "restarting", ...result, commit: r.describeInstance().commit });
  } catch (err) {
    const status = err.code === "ENORESTART" || err.code === "ERESTARTING" ? 409 : 500;
    res.status(status).json({
      error: { code: err.code || "ERESTARTFAILED", message: err.message || String(err) },
    });
  }
});

module.exports = router;
module.exports.__isLoopbackRequest = isLoopbackRequest;
