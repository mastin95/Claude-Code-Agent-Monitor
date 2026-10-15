/**
 * @file provider-filter.js
 * @description Shared SQL filters for the dashboard-wide Claude/Cursor/Codex
 * scope. The Claude product choice intentionally includes Cursor sessions,
 * matching onboarding, while direct `cursor` API scopes remain available.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { parseProjectScope, projectClause } = require("./project-scope");

const VALID_PROVIDERS = new Set(["claude", "cursor", "codex"]);

/** Parse `?providers=claude,codex`; absent means every provider. */
function parseProviderList(req) {
  const raw = req.query ? req.query.providers : undefined;
  if (typeof raw !== "string") return null;
  const providers = [
    ...new Set(
      raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => VALID_PROVIDERS.has(v))
    ),
  ];
  if (providers.length === 0) return null;
  // Cursor uses Claude-compatible lifecycle hooks but has its own transcript
  // store and rate card. Product scope keeps the existing two-choice UX:
  // "Claude Code" means the Claude-compatible family (Claude + Cursor).
  if (providers.includes("claude") && !providers.includes("cursor")) providers.push("cursor");
  return providers;
}

/** SQL predicate for a query that already aliases sessions. */
/**
 * Parse the product scope plus the Dirección project scope (`?project=<id>`). A project
 * scope rides on the returned list as `.project`, so every route that already narrows by
 * provider also narrows to the project's sessions without threading a new argument.
 */
function parseProviders(req) {
  const project = parseProjectScope(req);
  const providers = parseProviderList(req);
  if (!project) return providers;
  const list = providers || [...VALID_PROVIDERS];
  list.project = project;
  return list;
}

function joinClauses(...parts) {
  const used = parts.filter((part) => part.clause);
  return {
    clause: used.map((part) => part.clause).join(" AND "),
    params: used.flatMap((part) => part.params),
  };
}

function providerColumnClause(providers, col = "s.provider") {
  if (!providers || providers.length === 0) return { clause: "", params: [] };
  const prefix = col.includes(".") ? col.slice(0, col.lastIndexOf(".") + 1) : "";
  return joinClauses(
    { clause: `${col} IN (${providers.map(() => "?").join(",")})`, params: [...providers] },
    projectClause(providers.project, prefix)
  );
}

/** SQL predicate for tables that only carry a session id. */
function sessionIdInProvidersClause(providers, sessionIdCol) {
  if (!providers || providers.length === 0) return { clause: "", params: [] };
  const inner = providerColumnClause(providers, "provider");
  return {
    clause: `${sessionIdCol} IN (SELECT id FROM sessions WHERE ${inner.clause})`,
    params: inner.params,
  };
}

module.exports = { parseProviders, providerColumnClause, sessionIdInProvidersClause };
