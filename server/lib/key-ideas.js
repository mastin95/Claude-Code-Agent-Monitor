/**
 * @file Extracts explicitly marked assistant decisions and merges a bounded,
 * chronological key-idea history without overwriting other session metadata.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const KINDS = {
  enfoque: "approach",
  approach: "approach",
  giro: "pivot",
  pivot: "pivot",
  riesgo: "risk",
  risk: "risk",
  mejora: "improvement",
  improvement: "improvement",
};
const LIMIT = 12;

function extractKeyIdeas(text, at) {
  if (typeof text !== "string") return [];
  const ideas = [];
  let fence = null;
  const timestamp = new Date(at ?? Date.now());
  const time = Number.isNaN(timestamp.getTime())
    ? new Date().toISOString()
    : timestamp.toISOString();
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    // Four-space/tab indented Markdown code is code too.
    if (/^( {4}|\t)/.test(line)) continue;
    const match = line.match(
      /^\s*\[(enfoque|approach|giro|pivot|riesgo|risk|mejora|improvement)\]\s*(.*)$/i
    );
    if (!match) continue;
    const value = Array.from(match[2].replace(/\*\*|`/g, "").trim())
      .slice(0, 120)
      .join("");
    if (value) ideas.push({ kind: KINDS[match[1].toLowerCase()], text: value, at: time });
  }
  return mergeKeyIdeas([], ideas);
}

function mergeKeyIdeas(previous, incoming) {
  const unique = new Map();
  for (const idea of [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]) {
    if (
      !idea ||
      !Object.values(KINDS).includes(idea.kind) ||
      typeof idea.text !== "string" ||
      !idea.text.trim() ||
      !Number.isFinite(Date.parse(idea.at))
    )
      continue;
    const key = `${idea.kind}\0${idea.text}`;
    if (!unique.has(key)) unique.set(key, { kind: idea.kind, text: idea.text, at: idea.at });
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-LIMIT);
}

function storeSessionKeyIdeas(stmts, sessionId, ideas) {
  if (!ideas?.length) return false;
  const session = stmts.getSession.get(sessionId);
  if (!session) return false;
  let metadata = {};
  try {
    const parsed = JSON.parse(session.metadata || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    /* Repair invalid JSON without disrupting hook ingestion. */
  }
  const merged = mergeKeyIdeas(metadata.key_ideas, ideas);
  if (JSON.stringify(merged) === JSON.stringify(metadata.key_ideas)) return false;
  metadata.key_ideas = merged;
  stmts.updateSession.run(null, null, null, JSON.stringify(metadata), sessionId);
  return true;
}

module.exports = { extractKeyIdeas, mergeKeyIdeas, storeSessionKeyIdeas };
