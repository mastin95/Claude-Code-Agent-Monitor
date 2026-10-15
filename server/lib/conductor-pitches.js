/**
 * @file Pitch duel for Dirección: Claude and Codex each propose a new project in parallel
 *   (read-only runs that return a JSON pitch with idea cards and HTML mockups), Martin
 *   keeps the cards he likes from both, and the mix becomes the chosen lead's order.
 *   Spawners, persistence and the conductor are injectable so tests never launch agents.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { pitchPrompt, mixOrderText } = require("./conductor-prompts");
const { required, problem } = require("./conductor");

const AGENTS = ["claude", "codex"];
const KINDS = new Set(["estilo", "pantallas", "funciones", "plan", "tecnica", "toque", "otra"]);
const DEPTHS = { quick: "low", normal: null, deep: "high" };
const HEX = /^#[0-9a-f]{6}$/i;
const now = () => new Date().toISOString();

const text = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const list = (value, max, size) =>
  Array.isArray(value)
    ? value
        .map((item) => text(item, size))
        .filter(Boolean)
        .slice(0, max)
    : [];

/** First JSON object in an agent's answer: a ```json fence, else the outermost braces. */
function extractJson(answer) {
  if (typeof answer !== "string") return null;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(answer);
  const candidates = [fenced?.[1], answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Keep only the fields the page renders, bounded; mockup HTML is shown in a sandboxed frame. */
function normalizePitch(raw) {
  if (!raw || typeof raw !== "object") throw problem("the pitch is not a JSON object");
  const cards = (Array.isArray(raw.cards) ? raw.cards : [])
    .filter((card) => card && typeof card === "object")
    .slice(0, 12)
    .map((card) => {
      const kind = KINDS.has(String(card.kind).toLowerCase())
        ? String(card.kind).toLowerCase()
        : "otra";
      const out = { kind, title: text(card.title, 120) || kind, body: text(card.body, 1200) };
      const swatches = list(card.swatches, 6, 7).filter((c) => HEX.test(c));
      if (swatches.length) out.swatches = swatches;
      const items = list(card.items, 10, 200);
      if (items.length) out.items = items;
      const steps = list(card.steps, 8, 300);
      if (steps.length) out.steps = steps;
      const screens = (Array.isArray(card.screens) ? card.screens : [])
        .filter((s) => s && typeof s.html === "string" && s.html.trim())
        .slice(0, 3)
        .map((s, i) => ({ label: text(s.label, 60) || `${i + 1}`, html: s.html.slice(0, 30000) }));
      if (screens.length) out.screens = screens;
      return out;
    });
  if (!cards.length) throw problem("the pitch has no cards");
  return {
    name: text(raw.name, 80) || "Propuesta",
    tagline: text(raw.tagline, 200),
    cards,
  };
}

function createPitches({
  db = require("../db").db,
  claude = require("./run-spawner"),
  codex = require("./codex-run-spawner"),
  broadcast = require("../websocket").broadcast,
  conductor = () => require("./conductor").getConductor(),
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  const runs = new Map(); // pitchId -> { claude, codex, reply, timer }
  const lead = () => (typeof conductor === "function" ? conductor() : conductor);
  const row = (id) => db.prepare("SELECT * FROM conductor_pitches WHERE id = ?").get(id);
  function need(id) {
    const found = row(required(id, "pitchId", 200));
    if (!found) throw problem("pitch not found", 404);
    return found;
  }
  function publicPitch(r) {
    const side = (agent) => {
      let pitch = null;
      try {
        pitch = r[`${agent}_pitch`] ? JSON.parse(r[`${agent}_pitch`]) : null;
      } catch {
        pitch = null;
      }
      return {
        status: r[`${agent}_status`],
        runId: r[`${agent}_run_id`],
        pitch,
        error: r[`${agent}_error`],
      };
    };
    return {
      id: r.id,
      project_id: r.project_id,
      idea: r.idea,
      depth: r.depth,
      status: r.status,
      order_id: r.order_id,
      created_at: r.created_at,
      ended_at: r.ended_at,
      claude: side("claude"),
      codex: side("codex"),
    };
  }
  function patch(id, values) {
    db.prepare(
      `UPDATE conductor_pitches SET ${Object.keys(values)
        .map((k) => `${k} = @${k}`)
        .join(",")} WHERE id = @id`
    ).run({ ...values, id });
    const fresh = row(id);
    broadcast("conductor_pitch", publicPitch(fresh));
    return fresh;
  }
  /** Overall status follows the two sides: ready once neither is drafting and one succeeded. */
  function settle(id) {
    const r = row(id);
    if (!r || r.status !== "drafting") return r;
    const sides = AGENTS.map((a) => r[`${a}_status`]);
    if (sides.includes("drafting")) return r;
    const runtime = runs.get(id);
    clearTimeout(runtime?.timer);
    runs.delete(id);
    return patch(id, {
      status: sides.includes("ready") ? "ready" : "error",
      ended_at: now(),
    });
  }
  function side(id, agent, outcome) {
    const r = row(id);
    const runtime = runs.get(id);
    if (!r || r[`${agent}_status`] !== "drafting" || !runtime || runtime.done.has(agent)) return;
    // Mark first: killing a run reports its status back here synchronously.
    runtime.done.add(agent);
    const handle = runtime[agent];
    runtime[agent] = null;
    // Headless Claude exits by itself; the Codex app-server idles until killed.
    if (handle && (agent === "codex" || outcome.error))
      (agent === "claude" ? claude : codex).killRun(handle.id);
    if (outcome.error) {
      patch(id, { [`${agent}_status`]: "error", [`${agent}_error`]: outcome.error.slice(0, 2000) });
    } else {
      try {
        const pitch = normalizePitch(extractJson(outcome.answer));
        patch(id, { [`${agent}_status`]: "ready", [`${agent}_pitch`]: JSON.stringify(pitch) });
      } catch (err) {
        patch(id, {
          [`${agent}_status`]: "error",
          [`${agent}_error`]: `No se pudo leer la propuesta: ${err.message}`,
        });
      }
    }
    settle(id);
  }
  function claudeEvent(id, envelope) {
    if (envelope.type !== "result") return;
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== "success"))
      side(id, "claude", { error: String(envelope.result || "Claude no pudo terminar") });
    else side(id, "claude", { answer: envelope.result });
  }
  function codexEvent(id, envelope) {
    const runtime = runs.get(id);
    if (!runtime) return;
    const item = envelope.params?.item;
    if (
      envelope.method?.startsWith("item/") &&
      item &&
      ["agentMessage", "agent_message", "final_answer"].includes(item.type)
    ) {
      const value = item.text || item.message || item.content;
      if (typeof value === "string") runtime.reply = value;
      else if (Array.isArray(value)) runtime.reply = value.map((p) => p.text || "").join("\n");
    }
    if (envelope.method !== "turn/completed") return;
    const turn = envelope.params?.turn;
    if (turn?.error || ["failed", "interrupted"].includes(turn?.status))
      side(id, "codex", { error: turn?.error?.message || "Codex no pudo terminar" });
    else side(id, "codex", { answer: runtime.reply });
  }
  function onStatus(id, agent, status) {
    // A run that ends before answering (crash, kill, missing CLI) fails only its own side.
    if (["error", "killed", "completed"].includes(status))
      side(id, agent, { error: `${agent === "claude" ? "Claude" : "Codex"} terminó (${status})` });
  }
  function start(id, agent, project, prompt, effort) {
    const runtime = runs.get(id);
    try {
      if (agent === "claude") {
        runtime.claude = claude.spawnRun({
          prompt,
          mode: "headless",
          cwd: project.cwd,
          model: project.claude_model,
          effort: effort || project.claude_effort,
          // Read-only: in print mode any tool outside the allowlist is denied without a prompt.
          permissionMode: "default",
          allowedTools: ["Read", "Glob", "Grep"],
          onEnvelope: (e) => claudeEvent(id, e),
          onStatus: (s) => onStatus(id, "claude", s),
        });
      } else {
        runtime.codex = codex.spawnRun({
          prompt,
          cwd: project.cwd,
          model: project.codex_model,
          effort: effort || project.codex_effort,
          sandbox: "read-only",
          permissionMode: "never",
          onEnvelope: (e) => codexEvent(id, e),
          onStatus: (s) => onStatus(id, "codex", s),
          onRequest: () => false,
        });
      }
      if (runtime[agent]) patch(id, { [`${agent}_run_id`]: runtime[agent].id });
    } catch (err) {
      side(id, agent, { error: err.message || String(err) });
    }
  }
  function create({ projectId, idea, depth = "normal" } = {}) {
    const project = db
      .prepare("SELECT * FROM conductor_projects WHERE id = ?")
      .get(required(projectId, "projectId", 200));
    if (!project) throw problem("projects not found", 404);
    idea = required(idea, "idea", 20000);
    if (!Object.hasOwn(DEPTHS, depth)) throw problem("depth must be quick, normal or deep");
    if (!fs.statSync(project.cwd, { throwIfNoEntry: false })?.isDirectory())
      throw problem("cwd must be an existing directory");
    const busy = db
      .prepare("SELECT id FROM conductor_pitches WHERE project_id = ? AND status = 'drafting'")
      .get(project.id);
    if (busy) throw problem("this project already has a pitch duel in progress", 409);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO conductor_pitches (id, project_id, idea, depth, status, claude_status, codex_status, created_at)
       VALUES (?, ?, ?, ?, 'drafting', 'drafting', 'drafting', ?)`
    ).run(id, project.id, idea, depth, now());
    const runtime = { claude: null, codex: null, reply: "", timer: null, done: new Set() };
    runs.set(id, runtime);
    runtime.timer = setTimeout(() => {
      for (const agent of AGENTS) side(id, agent, { error: "Se acabó el tiempo" });
    }, timeoutMs);
    runtime.timer.unref?.();
    const prompt = pitchPrompt(idea, depth);
    for (const agent of AGENTS) start(id, agent, project, prompt, DEPTHS[depth]);
    return publicPitch(row(id));
  }
  function stop(id) {
    const r = need(id);
    if (r.status === "drafting") {
      for (const agent of AGENTS) side(id, agent, { error: "Parado por Martin" });
      return publicPitch(patch(id, { status: "stopped", ended_at: r.ended_at || now() }));
    }
    return publicPitch(r);
  }
  /** Martin's mix: picks reference cards by agent and index; the lead gets one combined order. */
  function choose(id, { picks, note, lead: who = "claude" } = {}, baseUrl) {
    const r = need(id);
    if (r.status !== "ready") throw problem("the pitches are not ready", 409);
    if (who !== "claude") throw problem("Phase 1 only supports claude as lead");
    if (note != null && (typeof note !== "string" || note.length > 5000))
      throw problem("note must be a string (max 5000)");
    if (!Array.isArray(picks) || !picks.length || picks.length > 40)
      throw problem("picks must be a non-empty array (max 40)");
    const pitch = publicPitch(r);
    const seen = new Set();
    const chosen = picks.map((pick) => {
      const agent = pick?.agent;
      const index = pick?.index;
      if (!AGENTS.includes(agent) || !Number.isInteger(index))
        throw problem("each pick needs agent (claude|codex) and an integer index");
      const card = pitch[agent].pitch?.cards?.[index];
      if (!card) throw problem(`no card ${index} in ${agent}'s pitch`);
      const key = `${agent}:${index}`;
      if (seen.has(key)) throw problem("duplicate pick");
      seen.add(key);
      return { agent, pitchName: pitch[agent].pitch.name, card };
    });
    const order = lead().createOrder(
      {
        projectId: r.project_id,
        text: mixOrderText({ idea: r.idea, picks: chosen, note: note?.trim() || null }).slice(
          0,
          50000
        ),
      },
      baseUrl
    );
    patch(id, { status: "used", order_id: order.id });
    return order;
  }
  function list(projectId, limit = 1) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 50)
      throw problem("limit must be an integer between 1 and 50");
    return db
      .prepare(
        "SELECT * FROM conductor_pitches WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(required(projectId, "projectId", 200), count)
      .map(publicPitch);
  }
  // Runs cannot be reattached after a restart; leave no duel drafting forever.
  for (const stale of db
    .prepare("SELECT id FROM conductor_pitches WHERE status = 'drafting'")
    .all()) {
    db.prepare(
      `UPDATE conductor_pitches SET status = 'error', ended_at = ?,
         claude_status = CASE claude_status WHEN 'drafting' THEN 'error' ELSE claude_status END,
         codex_status = CASE codex_status WHEN 'drafting' THEN 'error' ELSE codex_status END,
         claude_error = COALESCE(claude_error, 'Dashboard restarted'),
         codex_error = COALESCE(codex_error, 'Dashboard restarted')
       WHERE id = ?`
    ).run(now(), stale.id);
  }
  function close() {
    for (const id of [...runs.keys()])
      for (const agent of AGENTS) side(id, agent, { error: "Conductor closed" });
  }
  return {
    create,
    stop,
    choose,
    list,
    get: (id) => publicPitch(need(id)),
    close,
  };
}
let singleton;
function getPitches() {
  return (singleton ||= createPitches());
}
module.exports = { createPitches, getPitches, extractJson, normalizePitch };
