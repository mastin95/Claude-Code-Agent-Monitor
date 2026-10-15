/**
 * @file Loopback-guarded conductor API with validated projects, a folder browser for the
 *   New project picker, the pitch duel (both agents propose, Martin mixes), the whiteboard
 *   timeline (each agent draws its board live, Martin comments or calls an agent) and bounded
 *   long polls.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const { Router } = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const spawn = require("cross-spawn");
const { __sameOriginGuard: sameOriginGuard } = require("./run");
const { getConductor, required, problem } = require("../lib/conductor");
const { getPitches } = require("../lib/conductor-pitches");
const { getBoards } = require("../lib/conductor-boards");
const { projectOnlyEnabled } = require("../lib/project-scope");

// Folder picker for the New project form: a browser page cannot read real paths from its own
// file dialog, so the local server lists drives and sub-folders (names only, never contents).
const BROWSE_LIMIT = 500;
function browseRoots({ platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== "win32") return [{ name: "/", path: "/" }];
  const roots = [];
  for (let code = 65; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (exists(drive)) roots.push({ name: drive, path: drive });
    } catch {
      /* Unready drives (empty card readers) are simply skipped. */
    }
  }
  return roots;
}
function browsePlaces(home = os.homedir()) {
  return ["", "Desktop", "Documents", "Downloads"]
    .map((sub) => (sub ? path.join(home, sub) : home))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .map((dir) => ({ name: path.basename(dir) || dir, path: dir }));
}
function browseDir(raw) {
  const target = raw ? path.resolve(raw) : os.homedir();
  if (raw && !path.isAbsolute(raw)) throw problem("path must be absolute");
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    throw problem(
      err.code === "ENOENT" || err.code === "ENOTDIR"
        ? "folder not found"
        : `cannot open folder (${err.code || "error"})`,
      err.code === "ENOENT" || err.code === "ENOTDIR" ? 404 : 400
    );
  }
  const dirs = entries
    .filter((entry) => {
      if (entry.name.startsWith(".") || entry.name.startsWith("$")) return false;
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(target, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    sep: path.sep,
    dirs: dirs.slice(0, BROWSE_LIMIT).map((name) => ({ name, path: path.join(target, name) })),
    truncated: dirs.length > BROWSE_LIMIT,
    roots: browseRoots(),
    places: browsePlaces(),
  };
}

function createRouter({
  service = getConductor,
  pitches = getPitches,
  boards = getBoards,
  spawnGit = spawn,
} = {}) {
  const router = Router();
  router.use(sameOriginGuard);
  const handle =
    (fn, source = service) =>
    async (req, res) => {
      try {
        await fn(req, res, typeof source === "function" ? source() : source);
      } catch (err) {
        if (!res.destroyed)
          res
            .status(err.status || (err.code === "ECONCURRENCY" ? 429 : 500))
            .json({ error: { code: err.code || "ECONDUCTOR", message: err.message } });
      }
    };
  router.get(
    "/browse",
    handle((req, res) => {
      const raw = req.query.path;
      if (raw != null && (typeof raw !== "string" || raw.length > 4096))
        throw problem("path must be a string (max 4096)");
      res.json(browseDir(raw || null));
    })
  );
  router.get(
    "/projects",
    // project_only tells the UI to start empty and scope every page to one project.
    handle((_req, res, conductor) =>
      res.json({ items: conductor.listProjects(), project_only: projectOnlyEnabled() })
    )
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
  // Pitch duel: both agents propose the project read-only; Martin's mix becomes the order.
  router.post(
    "/pitches",
    handle((req, res, duel) => res.status(201).json(duel.create(req.body || {})), pitches)
  );
  router.get(
    "/pitches",
    handle(
      (req, res, duel) =>
        res.json({ items: duel.list(req.query.projectId, Number(req.query.limit ?? 1)) }),
      pitches
    )
  );
  router.get(
    "/pitches/:id",
    handle((req, res, duel) => res.json(duel.get(req.params.id)), pitches)
  );
  router.delete(
    "/pitches/:id",
    handle((req, res, duel) => res.json(duel.stop(req.params.id)), pitches)
  );
  router.post(
    "/pitches/:id/order",
    handle((req, res, duel) => {
      const port = req.socket.localPort;
      res.status(201).json(duel.choose(req.params.id, req.body || {}, `http://127.0.0.1:${port}`));
    }, pitches)
  );
  // Whiteboards: Claude then Codex draw the project live; each sheet is one timeline item.
  router.post(
    "/sheets",
    handle((req, res, pizarra) => res.status(201).json(pizarra.create(req.body || {})), boards)
  );
  router.get(
    "/sheets",
    handle(
      (req, res, pizarra) =>
        res.json({ items: pizarra.list(req.query.projectId, Number(req.query.limit ?? 30)) }),
      boards
    )
  );
  router.get(
    "/sheets/:id",
    handle((req, res, pizarra) => res.json(pizarra.get(req.params.id)), boards)
  );
  router.delete(
    "/sheets/:id",
    handle((req, res, pizarra) => res.json(pizarra.stop(req.params.id)), boards)
  );
  router.post(
    "/boards/:id/comments",
    handle(
      (req, res, pizarra) => res.status(201).json(pizarra.comment(req.params.id, req.body || {})),
      boards
    )
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
module.exports.__browse = { browseDir, browseRoots };
