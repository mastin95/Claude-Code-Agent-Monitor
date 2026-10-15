/**
 * @file Unwraps the routing envelopes that agent platforms (Claude Projects
 * threads, Remote Control relays, cross-session messages) wrap around the
 * human's words before they reach a Claude Code session. Without this, a
 * session started that way shows `<wake reason="mention" …>` as its title,
 * agent task, and card preview instead of what the person actually wrote.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

// Opening tags that only ever appear in platform routing envelopes.
const ENVELOPE_TAG_RE = /<(?:wake|relay|coordinator-relay|cross-session-message)\b/i;

// Shown when an envelope carries no human message at all (e.g. a pure
// harness notice). Short and neutral so it reads like the other auto labels.
const PLATFORM_MESSAGE_LABEL = "Platform message";

/** True when `text` contains a platform routing envelope. */
function hasPlatformEnvelope(text) {
  return typeof text === "string" && ENVELOPE_TAG_RE.test(text);
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return m ? m[1] : null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cleanBody(body) {
  const text = decodeEntities(
    body.replace(/<system-note>[\s\S]*?<\/system-note>/gi, "").replace(/<\/?[a-z][^>]*>/gi, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function lastMatchBody(text, re, accept) {
  let found = null;
  for (const m of text.matchAll(re)) {
    if (accept && !accept(m[1] || "")) continue;
    const body = cleanBody(m[2]);
    if (body) found = { body, attrs: m[1] || "" };
  }
  return found;
}

/**
 * Return the human-readable text inside a platform envelope, or `text`
 * unchanged when it carries none. Preference order: the newest human
 * `<message>` (the one that triggered the turn first), then the newest
 * `<cited author="user">` quote, then the coordinator's `<note>` brief, then
 * a cross-session message body. Falls back to a short neutral label.
 */
function unwrapPlatformEnvelope(text) {
  if (!hasPlatformEnvelope(text)) return text;

  const messageRe = /<message\b([^>]*)>([\s\S]*?)<\/message>/gi;
  const isHuman = (attrs) => (attr(attrs, "from") || "").toLowerCase() === "human";
  const trigger = lastMatchBody(
    text,
    messageRe,
    (attrs) => isHuman(attrs) && attr(attrs, "trigger") === "true"
  );
  if (trigger) return trigger.body;
  const human = lastMatchBody(text, messageRe, isHuman);
  if (human) return human.body;

  const cited = lastMatchBody(
    text,
    /<cited\b([^>]*)>([\s\S]*?)<\/cited>/gi,
    (attrs) => (attr(attrs, "author") || "").toLowerCase() === "user"
  );
  if (cited) return cited.body;

  const note = lastMatchBody(text, /<note\b([^>]*)>([\s\S]*?)<\/note>/gi);
  if (note) return note.body;

  const peer = lastMatchBody(
    text,
    /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/gi
  );
  if (peer) return peer.body;

  return PLATFORM_MESSAGE_LABEL;
}

module.exports = { hasPlatformEnvelope, unwrapPlatformEnvelope, PLATFORM_MESSAGE_LABEL };
