/**
 * @file Unwraps the routing envelopes that agent platforms (Claude Projects
 * threads, Remote Control relays, cross-session messages) wrap around the
 * human's words before they reach a Claude Code session. Without this, a
 * session started that way shows `<wake reason="mention" …>` as its title,
 * agent task, and card preview instead of what the person actually wrote.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

// Attribute list of an opening tag; quoted values may contain `>`.
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

// A routing envelope is only recognised when one of its opening tags is
// paired with the matching closing tag, so an ordinary prompt that merely
// mentions "<wake" is left alone.
const ENVELOPE_TAGS = ["wake", "relay", "coordinator-relay", "cross-session-message"];
const ENVELOPE_RES = ENVELOPE_TAGS.map(
  (tag) => new RegExp(`<${tag}(?:\\s${ATTRS})?>[\\s\\S]*</${tag}>`, "i")
);

// Labels stored before unwrapping existed: they BEGIN with an envelope tag
// (often truncated, so no closing tag survives).
const ENVELOPE_LABEL_RE =
  /^\s*(?:Main Agent - )?(?:<(?:wake|relay|coordinator-relay|cross-session-message)[\s>]|A message from this project.s coordinator session)/i;

// Shown when an envelope carries no human message at all (e.g. a pure
// harness notice). Short and neutral so it reads like the other auto labels.
const PLATFORM_MESSAGE_LABEL = "Platform message";

/** True when `text` contains a complete platform routing envelope. */
function hasPlatformEnvelope(text) {
  return typeof text === "string" && ENVELOPE_RES.some((re) => re.test(text));
}

/** True when a stored name/task is a raw envelope copied verbatim. */
function isPlatformEnvelopeLabel(text) {
  return typeof text === "string" && ENVELOPE_LABEL_RE.test(text);
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? (m[1] ?? m[2]) : null;
}

function decodeEntities(text) {
  const fromCode = (code) => {
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCode(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cleanBody(body) {
  const text = decodeEntities(
    body
      .replace(/<system-note\b[\s\S]*?<\/system-note>/gi, "")
      .replace(new RegExp(`</?[a-z][\\w-]*${ATTRS}>`, "gi"), " ")
  )
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function tagRe(tag) {
  // Bodies are lazy: platforms escape `<` in the human's own words, so an
  // unescaped closing tag inside a body does not occur in real envelopes.
  return new RegExp(`<${tag}(?:\\s${ATTRS})?>([\\s\\S]*?)</${tag}>`, "gi");
}

function lastMatchBody(text, re, accept) {
  let found = null;
  for (const m of text.matchAll(re)) {
    const attrs = m[1] || "";
    if (accept && !accept(attrs)) continue;
    const body = cleanBody(m[2]);
    if (body) found = body;
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

  const messageRe = tagRe("message");
  const isHuman = (attrs) => (attr(attrs, "from") || "").toLowerCase() === "human";
  const trigger = lastMatchBody(
    text,
    messageRe,
    (attrs) => isHuman(attrs) && attr(attrs, "trigger") === "true"
  );
  if (trigger) return trigger;
  const human = lastMatchBody(text, messageRe, isHuman);
  if (human) return human;

  const cited = lastMatchBody(
    text,
    tagRe("cited"),
    (attrs) => (attr(attrs, "author") || "").toLowerCase() === "user"
  );
  if (cited) return cited;

  const note = lastMatchBody(text, tagRe("note"));
  if (note) return note;

  const peer = lastMatchBody(text, tagRe("cross-session-message"));
  if (peer) return peer;

  return PLATFORM_MESSAGE_LABEL;
}

module.exports = {
  hasPlatformEnvelope,
  isPlatformEnvelopeLabel,
  unwrapPlatformEnvelope,
  PLATFORM_MESSAGE_LABEL,
};
