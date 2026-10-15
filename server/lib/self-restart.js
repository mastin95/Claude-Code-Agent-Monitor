/**
 * @file Self-restart for the standalone dashboard server. The running server
 * spawns a fresh detached copy of itself (in its own console window on
 * Windows), waits for that copy to confirm it started, and only then shuts
 * itself down; the copy waits for the old process to exit before binding the
 * port. No outside process ever has to kill the server, which is what lets an
 * update be installed hands-free (see scripts/update-monitor.js).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SERVER_SCRIPT = path.join(ROOT, "server", "index.js");
const WINDOW_TITLE = "Agent Monitor";
const ENV_WAIT_PID = "DASHBOARD_RESTART_WAIT_PID";
const ENV_ACK_FILE = "DASHBOARD_RESTART_ACK";

let shutdownHandler = null;
let restartInFlight = false;
const startedAt = new Date().toISOString();

/** The standalone entry point registers its graceful shutdown here. */
function registerShutdown(fn) {
  shutdownHandler = typeof fn === "function" ? fn : null;
}

/** True only when a standalone server registered a shutdown it can hand over. */
function canRestart() {
  return typeof shutdownHandler === "function";
}

/**
 * Read the checked-out commit straight from .git (no git subprocess). Returns
 * null when the server does not run from a git checkout.
 */
function readGitHead(root = ROOT) {
  try {
    const gitDir = path.join(root, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(4).trim();
    const refFile = path.join(gitDir, ...ref.split("/"));
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, "utf8").trim() || null;
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) {
      const [sha, name] = line.split(" ");
      if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  } catch {
    /* not a git checkout */
  }
  return null;
}

/** Identity of this server process, used to tell an old instance from a new one. */
function describeInstance() {
  return {
    pid: process.pid,
    commit: readGitHead(),
    startedAt,
    restartable: canRestart(),
  };
}

/**
 * Build the spawn call that starts a new server. On Windows it goes through
 * `start` so the server gets its own visible console window titled
 * "Agent Monitor" (closing that window stops it, as before); elsewhere it is a
 * plain detached node process logging to `logFile`.
 */
function buildLaunch({
  platform = process.platform,
  execPath = process.execPath,
  script = SERVER_SCRIPT,
  cwd = ROOT,
  env = process.env,
  logFd = "ignore",
} = {}) {
  if (platform === "win32") {
    const q = (s) => `"${s}"`;
    // cmd /k keeps the window open if the server ever crashes, so the error
    // stays readable. The doubled outer quotes follow cmd's /c quoting rule.
    const line = `start ${q(WINDOW_TITLE)} /D ${q(cwd)} cmd /k ` + `"${q(execPath)} ${q(script)}"`;
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", q(line)],
      options: {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    };
  }
  return {
    command: execPath,
    args: [script],
    options: { cwd, env, detached: true, stdio: ["ignore", logFd, logFd] },
  };
}

/** Launch a new detached server process. Returns the spawned ChildProcess. */
function launchServer({ env = process.env, logFile, spawnFn = spawn, platform } = {}) {
  let logFd = "ignore";
  if (logFile && (platform || process.platform) !== "win32") {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logFd = fs.openSync(logFile, "a");
    } catch {
      logFd = "ignore";
    }
  }
  const { command, args, options } = buildLaunch({ env, logFd, platform });
  const child = spawnFn(command, args, options);
  if (child && typeof child.unref === "function") child.unref();
  if (typeof logFd === "number") {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
  }
  return child;
}

function waitForFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Hand this server over to a fresh copy of itself. Resolves once the copy has
 * confirmed it is running; the shutdown of this process is then scheduled
 * shortly after so the HTTP response can still be delivered. Rejects (and
 * leaves this server running) when the copy never confirms.
 */
async function requestRestart({
  ackTimeoutMs = 15000,
  shutdownDelayMs = 300,
  logFile,
  spawnFn,
  platform,
} = {}) {
  if (!canRestart()) {
    const e = new Error("this dashboard instance cannot restart itself");
    e.code = "ENORESTART";
    throw e;
  }
  if (restartInFlight) {
    const e = new Error("a restart is already in progress");
    e.code = "ERESTARTING";
    throw e;
  }
  restartInFlight = true;
  const ackFile = path.join(
    os.tmpdir(),
    `agent-monitor-restart-${process.pid}-${crypto.randomBytes(4).toString("hex")}.ack`
  );
  try {
    const env = { ...process.env, [ENV_WAIT_PID]: String(process.pid), [ENV_ACK_FILE]: ackFile };
    launchServer({ env, logFile, spawnFn, platform });
    const confirmed = await waitForFile(ackFile, ackTimeoutMs);
    if (!confirmed) {
      const e = new Error("the new server did not start; this one keeps running");
      e.code = "ESPAWNTIMEOUT";
      throw e;
    }
    try {
      fs.unlinkSync(ackFile);
    } catch {
      /* ignore */
    }
    const handler = shutdownHandler;
    setTimeout(() => handler("restart"), shutdownDelayMs);
    return { oldPid: process.pid };
  } catch (err) {
    restartInFlight = false;
    throw err;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Called first thing by a server started through requestRestart(): confirm the
 * start to the old server, then wait (bounded) for it to exit so the port and
 * the single-server guard are free. A no-op for a normal start.
 */
async function awaitPredecessor({ env = process.env, timeoutMs = 20000, isAlive = pidAlive } = {}) {
  const ackFile = env[ENV_ACK_FILE];
  const waitPid = parseInt(env[ENV_WAIT_PID] || "", 10);
  delete env[ENV_ACK_FILE];
  delete env[ENV_WAIT_PID];
  if (ackFile) {
    try {
      fs.writeFileSync(ackFile, String(process.pid));
    } catch {
      /* the old server then times out and keeps running */
    }
  }
  if (!Number.isInteger(waitPid) || waitPid <= 0 || waitPid === process.pid) return false;
  const deadline = Date.now() + timeoutMs;
  while (isAlive(waitPid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

function _resetForTests() {
  shutdownHandler = null;
  restartInFlight = false;
}

module.exports = {
  registerShutdown,
  canRestart,
  readGitHead,
  describeInstance,
  buildLaunch,
  launchServer,
  requestRestart,
  awaitPredecessor,
  ENV_WAIT_PID,
  ENV_ACK_FILE,
  WINDOW_TITLE,
  _resetForTests,
};
