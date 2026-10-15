#!/usr/bin/env node
/**
 * @file Hands-free update of a local dashboard checkout: save stray changes in
 * a stash, fast-forward master, reinstall dependencies only when a lockfile
 * changed, rebuild the client, then ask the running server to restart itself
 * (POST /api/system/restart) and wait until the new instance answers with the
 * new commit. Starts the server if none is running. Usage:
 *   npm run update-monitor -- [--no-pull] [--no-build] [--force] [--port N]
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const http = require("http");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { gitSafeEnv } = require("../server/lib/git-env");
const { launchServer } = require("../server/lib/self-restart");

const ROOT = path.resolve(__dirname, "..");
const BRANCH = "master";

function parseArgs(argv) {
  const opts = { pull: true, build: true, force: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-pull") opts.pull = false;
    else if (a === "--no-build") opts.build = false;
    else if (a === "--force") opts.force = true;
    else if (a === "--port") opts.port = parseInt(argv[++i], 10);
    else throw new Error(`unknown option ${a}`);
  }
  opts.port = opts.port || parseInt(process.env.DASHBOARD_PORT || "4820", 10);
  return opts;
}

function log(msg) {
  console.log(`[update-monitor] ${msg}`);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, env: gitSafeEnv(process.env), encoding: "utf8" })
    .toString()
    .trim();
}

function npm(args, cwd = ROOT) {
  const viaNpm = process.env.npm_execpath;
  const result = viaNpm
    ? spawnSync(process.execPath, [viaNpm, ...args], { cwd, stdio: "inherit" })
    : spawnSync("npm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${cwd}`);
}

function request(method, port, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (process.env.DASHBOARD_TOKEN)
      headers.Authorization = `Bearer ${process.env.DASHBOARD_TOKEN}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers, timeout: 30000 },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", (err) => resolve({ status: 0, error: err.code || err.message }));
    req.on("timeout", () => req.destroy(new Error("ETIMEDOUT")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForNewInstance(port, oldPid, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request("GET", port, "/api/system/instance");
    if (r.status === 200 && r.json && r.json.pid !== oldPid) return r.json;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return null;
}

function updateCheckout(opts) {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    const name = `update-monitor ${new Date().toISOString()}`;
    git(["stash", "push", "-u", "-m", name]);
    log(`saved uncommitted changes in a stash: "${name}" (git stash list)`);
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== BRANCH) {
    log(`switching from ${branch} to ${BRANCH}`);
    git(["checkout", BRANCH]);
  }
  const before = git(["rev-parse", "HEAD"]);
  if (opts.pull) git(["pull", "--ff-only", "origin", BRANCH]);
  const after = git(["rev-parse", "HEAD"]);
  log(
    before === after
      ? `already at ${after.slice(0, 7)}`
      : `${before.slice(0, 7)} -> ${after.slice(0, 7)}`
  );
  const changed =
    before === after ? [] : git(["diff", "--name-only", before, after]).split(/\r?\n/);
  return { before, after, changed, stashed: Boolean(dirty) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { after, changed, stashed } = updateCheckout(opts);

  if (changed.includes("package-lock.json")) {
    log("root dependencies changed: npm install");
    npm(["install"]);
  }
  if (changed.includes("client/package-lock.json")) {
    log("client dependencies changed: npm install in client/");
    npm(["install"], path.join(ROOT, "client"));
  }
  if (opts.build) {
    log("building the client");
    npm(["run", "build"]);
  }

  const current = await request("GET", opts.port, "/api/system/instance");
  let fresh;
  if (current.status === 0) {
    log(`no server on port ${opts.port}: starting one`);
    launchServer();
    fresh = await waitForNewInstance(opts.port, null);
  } else if (current.status === 404) {
    log(
      "the running Monitor is older than self-restart, so it cannot restart itself. " +
        "Restart it by hand this one time (close its window, then run `node server/index.js` here); " +
        "every later update restarts on its own."
    );
    process.exit(2);
  } else if (current.status !== 200) {
    throw new Error(`unexpected answer from the server: HTTP ${current.status}`);
  } else {
    const r = await request("POST", opts.port, "/api/system/restart", { force: opts.force });
    if (r.status !== 202) {
      const err = r.json?.error || {};
      log(`restart refused (HTTP ${r.status} ${err.code || ""}): ${err.message || r.error || ""}`);
      process.exit(err.code === "EBUSY" ? 3 : 1);
    }
    log(`old server (pid ${current.json.pid}) is handing over`);
    fresh = await waitForNewInstance(opts.port, current.json.pid);
  }

  if (!fresh) throw new Error("the new server did not answer in time");
  const ok = !fresh.commit || fresh.commit === after;
  log(
    `Monitor running: pid ${fresh.pid}, commit ${(fresh.commit || "?").slice(0, 7)}` +
      (ok ? "" : ` (expected ${after.slice(0, 7)})`)
  );
  console.log(JSON.stringify({ ok, pid: fresh.pid, commit: fresh.commit, stashed }));
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    log(`failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
