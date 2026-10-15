/**
 * @file Loopback-guarded conductor API with validated projects and bounded long polls.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { Router } = require("express");
const fs = require("node:fs");
const path = require("node:path");
const spawn = require("cross-spawn");
const { __sameOriginGuard: sameOriginGuard } = require("./run");
const { getConductor, required, problem } = require("../lib/conductor");

function createRouter({ service = getConductor, spawnGit = spawn } = {}) {
  const router = Router();
  router.use(sameOriginGuard);
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res, typeof service === "function" ? service() : service);
    } catch (err) {
      if (!res.destroyed)
        res
          .status(err.status || (err.code === "ECONCURRENCY" ? 429 : 500))
          .json({ error: { code: err.code || "ECONDUCTOR", message: err.message } });
    }
  };
  router.get(
    "/projects",
    handle((_req, res, conductor) => res.json({ items: conductor.listProjects() }))
  );
  router.post(
    "/projects",
    handle(async (req, res, conductor) => {
      const body = req.body || {};
      const cwd = required(body.cwd, "cwd", 4096);
      if (!path.isAbsolute(cwd)) throw problem("cwd must be absolute");
      const lead = body.lead || "claude";
      if (lead !== "claude")
        throw problem(
          lead === "codex"
            ? "Phase 1 only supports claude as lead; codex is a collaborator"
            : "lead must be claude or codex"
        );
      if (body.create != null && typeof body.create !== "boolean")
        throw problem("create must be boolean");
      if (body.models != null && (typeof body.models !== "object" || Array.isArray(body.models)))
        throw problem("models must be an object");
      const models = body.models || {};
      for (const provider of ["claude", "codex"]) {
        if (
          models[provider] != null &&
          (typeof models[provider] !== "object" || Array.isArray(models[provider]))
        ) {
          throw problem(`models.${provider} must be an object`);
        }
      }
      const option = (agent, key) => {
        const value = body[`${agent}_${key}`] ?? models[agent]?.[key] ?? null;
        if (value != null && (typeof value !== "string" || !value.trim() || value.length > 200))
          throw problem(`${agent}_${key} must be a non-empty string (max 200)`);
        return value;
      };
      const project = {
        cwd,
        name: body.name == null ? path.basename(cwd) || cwd : required(body.name, "name", 200),
        lead,
        claude_model: option("claude", "model"),
        claude_effort: option("claude", "effort"),
        codex_model: option("codex", "model"),
        codex_effort: option("codex", "effort"),
        codex_sandbox: option("codex", "sandbox") || "workspace-write",
      };
      for (const agent of ["claude", "codex"]) {
        const levels = [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          ...(agent === "codex" ? ["ultra"] : []),
        ];
        if (project[`${agent}_effort`] && !levels.includes(project[`${agent}_effort`]))
          throw problem(`unsupported ${agent} effort`);
      }
      if (!["read-only", "workspace-write", "danger-full-access"].includes(project.codex_sandbox))
        throw problem("unsupported codex sandbox");
      if (!fs.existsSync(cwd)) {
        if (!body.create) throw problem("cwd must be an existing directory (or use create:true)");
        fs.mkdirSync(cwd, { recursive: true });
      }
      if (!fs.statSync(cwd).isDirectory()) throw problem("cwd must be a directory");
      project.cwd = fs.realpathSync(cwd);
      if (body.create) {
        await new Promise((resolve, reject) => {
          const child = spawnGit("git", ["init"], {
            cwd: project.cwd,
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(problem("git init failed", 500))
          );
        });
      }
      res.status(201).json(conductor.insertProject(project));
    })
  );
  router.post(
    "/orders",
    handle((req, res, conductor) => {
      // Use the actual listening socket, never an untrusted Host header or proxy header.
      const port = req.socket.localPort;
      res.status(201).json(conductor.createOrder(req.body || {}, `http://127.0.0.1:${port}`));
    })
  );
  router.get(
    "/orders/:id",
    handle((req, res, conductor) => res.json(conductor.getOrder(req.params.id)))
  );
  router.get(
    "/orders",
    handle((req, res, conductor) =>
      res.json({ items: conductor.listOrders(req.query.projectId, req.query.limit ?? 20) })
    )
  );
  router.delete(
    "/orders/:id",
    handle((req, res, conductor) => res.json(conductor.stop(req.params.id)))
  );
  router.post(
    "/orders/:id/indication",
    handle((req, res, conductor) => res.json(conductor.indication(req.params.id, req.body?.text)))
  );
  router.post(
    "/handoffs",
    handle((req, res, conductor) => res.status(202).json(conductor.handoff(req.body || {})))
  );
  router.post(
    "/approvals",
    handle((req, res, conductor) => res.status(202).json(conductor.createApproval(req.body || {})))
  );
  router.post(
    "/approvals/:id",
    handle((req, res, conductor) =>
      res.json(conductor.answerApproval(req.params.id, req.body || {}))
    )
  );
  for (const [route, table] of [
    ["handoffs", "rounds"],
    ["approvals", "approvals"],
  ]) {
    router.get(
      `/${route}/:id`,
      handle(async (req, res, conductor) => {
        const abort = new AbortController();
        const closed = () => abort.abort();
        res.once("close", closed);
        try {
          const value = await conductor.poll(
            table,
            req.params.id,
            req.query.waitMs || 0,
            abort.signal
          );
          if (!res.destroyed) res.json(value);
        } finally {
          res.removeListener("close", closed);
        }
      })
    );
  }
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
