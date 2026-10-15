/**
 * @file Tests for the dashboard self-restart: the Windows/POSIX launch command,
 * the start-confirmation handshake between old and new server, the
 * predecessor wait, and the loopback-only POST /api/system/restart route.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "self-restart-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "test.db");

const express = require("express");
const selfRestart = require("../lib/self-restart");
const systemRouter = require("../routes/system");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => selfRestart._resetForTests());

test("Windows launch opens its own titled console window through start", () => {
  const { command, args, options } = selfRestart.buildLaunch({
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\repo dir\\server\\index.js",
    cwd: "C:\\repo dir",
    env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
  });
  assert.equal(command, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    args[3],
    '"start "Agent Monitor" /D "C:\\repo dir" cmd /k ""C:\\Program Files\\nodejs\\node.exe" "C:\\repo dir\\server\\index.js"""'
  );
  assert.equal(options.detached, true);
  assert.equal(options.windowsVerbatimArguments, true);
});

test("POSIX launch is a detached node process", () => {
  const { command, args, options } = selfRestart.buildLaunch({
    platform: "linux",
    execPath: "/usr/bin/node",
    script: "/repo/server/index.js",
    cwd: "/repo",
    env: {},
  });
  assert.equal(command, "/usr/bin/node");
  assert.deepEqual(args, ["/repo/server/index.js"]);
  assert.equal(options.detached, true);
});

test("restart is refused when no standalone server registered a shutdown", async () => {
  await assert.rejects(selfRestart.requestRestart({ spawnFn: () => ({}) }), {
    code: "ENORESTART",
  });
});

test("old server shuts down only after the new one confirms it started", async () => {
  let shutdownReason = null;
  selfRestart.registerShutdown((reason) => (shutdownReason = reason));
  let childEnv = null;
  const spawnFn = (_cmd, _args, options) => {
    childEnv = { ...options.env };
    // Simulate the new server's first step.
    setTimeout(
      () => selfRestart.awaitPredecessor({ env: { ...childEnv }, isAlive: () => false }),
      50
    );
    return { unref() {} };
  };
  const result = await selfRestart.requestRestart({ spawnFn, shutdownDelayMs: 10 });
  assert.equal(result.oldPid, process.pid);
  assert.equal(childEnv[selfRestart.ENV_WAIT_PID], String(process.pid));
  assert.equal(shutdownReason, null, "shutdown must be deferred so the response is sent");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(shutdownReason, "restart");
  assert.equal(fs.existsSync(childEnv[selfRestart.ENV_ACK_FILE]), false, "ack file cleaned up");
});

test("old server keeps running when the new one never confirms", async () => {
  let shutdownCalled = false;
  selfRestart.registerShutdown(() => (shutdownCalled = true));
  await assert.rejects(
    selfRestart.requestRestart({ spawnFn: () => ({ unref() {} }), ackTimeoutMs: 200 }),
    { code: "ESPAWNTIMEOUT" }
  );
  assert.equal(shutdownCalled, false);
  // A failed attempt does not wedge later ones.
  await assert.rejects(
    selfRestart.requestRestart({ spawnFn: () => ({ unref() {} }), ackTimeoutMs: 50 }),
    { code: "ESPAWNTIMEOUT" }
  );
});

test("new server waits for the old pid to exit, and normal starts do not wait", async () => {
  assert.equal(await selfRestart.awaitPredecessor({ env: {} }), false);
  let polls = 0;
  const env = { [selfRestart.ENV_WAIT_PID]: "999999" };
  const waited = await selfRestart.awaitPredecessor({ env, isAlive: () => ++polls < 3 });
  assert.equal(waited, true);
  assert.equal(polls, 3);
  assert.equal(env[selfRestart.ENV_WAIT_PID], undefined, "env var consumed");
});

test("readGitHead resolves a branch ref and packed refs", () => {
  const repo = fs.mkdtempSync(path.join(TMP, "repo-"));
  const sha = "a".repeat(40);
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/master\n");
  fs.writeFileSync(path.join(repo, ".git", "packed-refs"), `# pack\n${sha} refs/heads/master\n`);
  assert.equal(selfRestart.readGitHead(repo), sha);
  const sha2 = "b".repeat(40);
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "master"), `${sha2}\n`);
  assert.equal(selfRestart.readGitHead(repo), sha2);
  assert.equal(selfRestart.readGitHead(path.join(TMP, "nope")), null);
});

function serve(locals) {
  const app = express();
  app.use(express.json());
  Object.assign(app.locals, locals);
  app.use("/api/system", systemRouter);
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function call(server, method, urlPath, { body, headers = {} } = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test("POST /api/system/restart hands over, refuses when busy or cross-origin", async () => {
  let restarts = 0;
  let busy = 1;
  const fakeRestarter = {
    describeInstance: () => ({ pid: 42, commit: "c".repeat(40), restartable: true }),
    requestRestart: async () => {
      restarts++;
      return { oldPid: 42 };
    },
  };
  const server = await serve({ selfRestart: fakeRestarter, liveRunCount: () => busy });
  try {
    const info = await call(server, "GET", "/api/system/instance");
    assert.equal(info.json.pid, 42);

    const refused = await call(server, "POST", "/api/system/restart");
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "EBUSY");
    assert.equal(restarts, 0);

    const forced = await call(server, "POST", "/api/system/restart", { body: { force: true } });
    assert.equal(forced.status, 202);
    assert.equal(forced.json.status, "restarting");
    assert.equal(restarts, 1);

    busy = 0;
    const cross = await call(server, "POST", "/api/system/restart", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(cross.status, 403);
    assert.equal(restarts, 1);

    const ok = await call(server, "POST", "/api/system/restart");
    assert.equal(ok.status, 202);
    assert.equal(restarts, 2);
  } finally {
    server.close();
  }
});

test("restart is loopback-only", () => {
  const isLocal = systemRouter.__isLoopbackRequest;
  assert.equal(isLocal({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLocal({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLocal({ socket: { remoteAddress: "192.168.1.20" } }), false);
  assert.equal(isLocal({ socket: {} }), false);
});
