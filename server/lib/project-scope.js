/**
 * @file Project scope: the Monitor only keeps and shows work born inside its own Dirección
 *   projects. A session belongs to a project when its folder is the project's folder (or a
 *   sub-folder) and it started after the project was created. Ingest paths ask
 *   `admitsNewSession` before creating a session; read routes narrow to `?project=<id>`
 *   through `parseProjectScope` + `projectClause`. `DASHBOARD_PROJECT_ONLY=0` restores the
 *   upstream behaviour of importing every Claude/Codex session on the machine.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

/** Ingest gate switch. Node's test runner keeps the upstream behaviour unless a test opts in. */
function projectOnlyEnabled() {
  const raw = process.env.DASHBOARD_PROJECT_ONLY;
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return !process.env.NODE_TEST_CONTEXT;
}

/** Folder comparison key: forward slashes, no trailing slash, case-insensitive (Windows). */
function normalizeCwd(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  return cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function insideFolder(cwd, folder) {
  const a = normalizeCwd(cwd);
  const b = normalizeCwd(folder);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`);
}

function lazyDb() {
  return require("../db").db;
}

function listProjects(db) {
  try {
    return db.prepare("SELECT id, cwd, created_at FROM conductor_projects").all();
  } catch {
    return [];
  }
}

/**
 * Whether a session that does not exist yet may be created.
 *
 * @param {string|null|undefined} cwd The session's working folder.
 * @param {string|number|null} [startedAt] When it started (ISO or ms); defaults to now.
 * @param {object} [db] Connection override (tests).
 */
function admitsNewSession(cwd, startedAt = null, db = null) {
  if (!projectOnlyEnabled()) return true;
  if (!normalizeCwd(cwd)) return false;
  const at = startedAt == null ? Date.now() : new Date(startedAt).getTime();
  return listProjects(db || lazyDb()).some((project) => {
    if (!insideFolder(cwd, project.cwd)) return false;
    const since = Date.parse(project.created_at);
    // Sessions without a readable start time are judged by folder alone.
    return !Number.isFinite(at) || !Number.isFinite(since) || at >= since;
  });
}

/**
 * Reads `?project=<id>` into `{ id, cwd, since }`. An unknown id yields a scope that
 * matches nothing, so a stale client never falls back to showing every session.
 */
function parseProjectScope(req, db = null) {
  const raw = req?.query?.project;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let row = null;
  try {
    row = (db || lazyDb())
      .prepare("SELECT id, cwd, created_at FROM conductor_projects WHERE id = ?")
      .get(raw.trim());
  } catch {
    row = null;
  }
  if (!row) return { id: raw.trim(), cwd: "\u0000no-project", since: "9999-12-31T00:00:00.000Z" };
  return { id: row.id, cwd: normalizeCwd(row.cwd) || "\u0000no-project", since: row.created_at };
}

const escapeLike = (value) => value.replace(/[!%_]/g, (ch) => `!${ch}`);

/**
 * SQL predicate over the sessions table (optionally aliased) for one project scope.
 *
 * @param {{cwd: string, since: string}|null} scope
 * @param {string} [prefix] Column prefix such as `"s."`.
 * @returns {{clause: string, params: string[]}}
 */
function projectClause(scope, prefix = "") {
  if (!scope) return { clause: "", params: [] };
  const cwd = `rtrim(lower(replace(${prefix}cwd, '\\', '/')), '/')`;
  return {
    clause: `(${prefix}started_at >= ? AND (${cwd} = ? OR ${cwd} LIKE ? ESCAPE '!'))`,
    params: [scope.since, scope.cwd, `${escapeLike(scope.cwd)}/%`],
  };
}

/** Whether a session row (with cwd and started_at) falls inside a scope. */
function sessionInScope(session, scope) {
  if (!scope) return true;
  if (!session || !insideFolder(session.cwd, scope.cwd)) return false;
  return String(session.started_at || "") >= String(scope.since);
}

module.exports = {
  projectOnlyEnabled,
  normalizeCwd,
  insideFolder,
  admitsNewSession,
  parseProjectScope,
  projectClause,
  sessionInScope,
};
