// Pure, dependency-free helpers for the widget's server API — no Express, no I/O.

// Untrusted invite text, capped before any regex touches it.
const MAX_RAW_TEXT_LEN = 20000;
function capRawText(raw) {
  const s = raw == null ? '' : String(raw);
  return s.length > MAX_RAW_TEXT_LEN ? s.slice(0, MAX_RAW_TEXT_LEN) : s;
}

// ── Notes / location plain-text conversion ──────────────────────────────

// Tag allowlist mirroring the web app's; excludes `<`/`>` so an unclosed tag fails fast.
const HTML_TAG_RE = new RegExp(
  '</?(?:a|b|i|u|s|em|strong|p|div|span|br|hr|ul|ol|li|dl|dt|dd|table|thead'
  + '|tbody|tfoot|tr|td|th|h[1-6]|blockquote|pre|code|img|font|small|sub|sup'
  + '|caption|center|figure|section|article|o:p)(?:\\s[^<>]*)?/?>', 'i'
);

function looksLikeHtml(s) {
  return HTML_TAG_RE.test(s);
}

// Only a fixed set of entities: named amp/lt/gt/quot/apos/nbsp, plus decimal/hex numeric refs.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g;

// Highest code point String.fromCodePoint() (and Unicode itself) accepts.
const MAX_CODE_POINT = 0x10ffff;

// Code point 0 and the surrogate range are accepted by fromCodePoint() but aren't valid standalone text.
function isUnsafeCodePoint(code) {
  return code === 0 || (code >= 0xd800 && code <= 0xdfff);
}

function decodeEntitiesOnce(str) {
  return str.replace(ENTITY_RE, (match, ref) => {
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ref)) return NAMED_ENTITIES[ref];
    const isHex = ref[1] === 'x' || ref[1] === 'X';
    const code = isHex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    // Out-of-range or unsafe code points are kept as literal entity text.
    const valid = Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT && !isUnsafeCodePoint(code);
    return valid ? String.fromCodePoint(code) : match;
  });
}

// Tags dropped together with their entire content (never shown, even as text).
const DROP_TAGS = ['script', 'style', 'head', 'title'];
const isTagWordChar = (code) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isAsciiSpace = (code) => code === 32 || (code >= 9 && code <= 13);

// ASCII-fold case-insensitive check that s[pos..] starts with `lower` (already lowercase).
function startsWithCI(s, pos, lower) {
  if (pos + lower.length > s.length) return false;
  for (let k = 0; k < lower.length; k++) {
    let c = s.charCodeAt(pos + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lower.charCodeAt(k)) return false;
  }
  return true;
}

// Earliest well-formed drop-tag opener at/after `from`, or null; one forward pass, no rescanning.
function findDropOpener(s, from) {
  const n = s.length;
  let pos = from;
  while (pos < n) {
    const lt = s.indexOf('<', pos);
    if (lt === -1) return null;
    for (const tag of DROP_TAGS) {
      if (!startsWithCI(s, lt + 1, tag)) continue;
      const afterName = lt + 1 + tag.length;
      if (isTagWordChar(s.charCodeAt(afterName))) continue; // \b fails, e.g. "<scriptx"
      let p = afterName;
      while (p < n && s.charCodeAt(p) !== 60 && s.charCodeAt(p) !== 62) p++;
      if (p < n && s.charCodeAt(p) === 62) return { start: lt, contentStart: p + 1, tag };
    }
    pos = lt + 1;
  }
  return null;
}

// Index right after the matching "</tag\s*>" at/after `from`, or -1 if none exists.
function findDropCloser(s, from, tag) {
  const n = s.length;
  let pos = from;
  while (pos < n) {
    const idx = s.indexOf('</', pos);
    if (idx === -1) return -1;
    if (startsWithCI(s, idx + 2, tag)) {
      let p = idx + 2 + tag.length;
      while (p < n && isAsciiSpace(s.charCodeAt(p))) p++;
      if (p < n && s.charCodeAt(p) === 62) return p + 1;
    }
    pos = idx + 1;
  }
  return -1;
}

// Start of the LAST well-formed closer for `tag` in the whole string, or -1 if none exists at all.
function lastDropCloserStart(s, tag) {
  const n = s.length;
  let last = -1;
  let pos = 0;
  while (pos < n) {
    const idx = s.indexOf('</', pos);
    if (idx === -1) break;
    if (startsWithCI(s, idx + 2, tag)) {
      let p = idx + 2 + tag.length;
      while (p < n && isAsciiSpace(s.charCodeAt(p))) p++;
      if (p < n && s.charCodeAt(p) === 62) { last = idx; pos = p + 1; continue; }
    }
    pos = idx + 1;
  }
  return last;
}

// Drops script/style/head/title tags with their content; a closer-less opener only rules itself out, not later tags.
function stripDropWithContent(s) {
  const lastCloserStart = {};
  for (const tag of DROP_TAGS) lastCloserStart[tag] = lastDropCloserStart(s, tag);

  let out = '';
  let i = 0; // start of text not yet emitted, only advances on a successful strip
  let searchPos = 0; // next position to look for a candidate opener, always advances
  while (searchPos < s.length) {
    const open = findDropOpener(s, searchPos);
    if (!open) break;
    // No closer for this tag exists anywhere past contentStart: skip just this opener in O(1), not a full rescan.
    if (lastCloserStart[open.tag] < open.contentStart) { searchPos = open.start + 1; continue; }
    const closeEnd = findDropCloser(s, open.contentStart, open.tag);
    if (closeEnd === -1) { searchPos = open.start + 1; continue; } // defensive; precheck above should preclude this
    out += s.slice(i, open.start);
    i = closeEnd;
    searchPos = closeEnd;
  }
  return out + s.slice(i);
}

// Drops HTML comments, same forward-scan reasoning as stripDropWithContent.
function stripComments(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('<!--', i);
    if (start === -1) return out + s.slice(i);
    const closeAt = s.indexOf('-->', start + 4);
    if (closeAt === -1) return out + s.slice(i);
    out += s.slice(i, start);
    i = closeAt + 3;
  }
  return out;
}

// br/p/div/tr/h1-6/table/ul/ol -> a newline, open or close, self-closing or not.
const NEWLINE_TAG_RE = /<\/?(?:br|p|div|tr|h[1-6]|table|ul|ol)(?:\s[^<>]*)?\/?>/gi;
const LI_OPEN_RE = /<li(?:\s[^<>]*)?>/gi;
const LI_CLOSE_RE = /<\/li\s*>/gi;
// A table cell boundary reads as a word gap, not nothing.
const TD_TH_CLOSE_RE = /<\/(?:td|th)\s*>/gi;
const ANY_TAG_RE = /<[^<>]*>/g;
// A line made up of 5-or-more separator characters (any mix of _ - = * ~).
const SEPARATOR_LINE_RE = /^[-_=*~]{5,}$/;

function stripHtml(input) {
  let s = stripDropWithContent(input);
  s = stripComments(s);
  // li must run before the generic newline pass, or it gets swallowed there.
  s = s.replace(LI_OPEN_RE, '\n• ');
  s = s.replace(LI_CLOSE_RE, '');
  s = s.replace(TD_TH_CLOSE_RE, ' ');
  s = s.replace(NEWLINE_TAG_RE, '\n');
  s = s.replace(ANY_TAG_RE, '');
  return s;
}

// Trims trailing characters matching `test`, without an anchored regex — stays linear regardless of what follows.
function trimEndWhile(str, test) {
  let end = str.length;
  while (end > 0 && test(str.charCodeAt(end - 1))) end--;
  return end === str.length ? str : str.slice(0, end);
}

const isSpaceOrTab = (code) => code === 32 || code === 9;

// Converts a raw description/location field (plain text, HTML, or entity-encoded HTML) to plain text.
export function htmlToPlainText(raw, { maxLen } = {}) {
  const input = capRawText(raw);
  // Entities are pre-decoded only when the text doesn't already look like HTML (keeps e.g. "type <br>" literal).
  let text = looksLikeHtml(input) ? input : decodeEntitiesOnce(input);
  if (looksLikeHtml(text)) {
    text = stripHtml(text);
    text = decodeEntitiesOnce(text);
  }

  text = text
    .split('\n')
    .map((line) => trimEndWhile(line, isSpaceOrTab))
    .filter((line) => !SEPARATOR_LINE_RE.test(line.trim()))
    .join('\n');

  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (typeof maxLen === 'number' && text.length > maxLen) {
    text = text.slice(0, Math.max(0, maxLen - 1)) + '…';
  }
  return text;
}

// ── Meeting URL detection ────────────────────────────────────────────────

// https:// URLs in raw text or inside an href="..." attribute (the quote stops the match for the attribute case).
const URL_CANDIDATE_RE = /https:\/\/[^\s"'<>]+/gi;
// A candidate is cut at the first of these, checked after entity decoding so a decoded quote/space/newline still ends it.
const CANDIDATE_BOUNDARY_RE = /[\s"'<>]/;
const TRAILING_PUNCTUATION_CODES = new Set(
  [')', ']', '}', '>', '.', ',', ';', '"', "'"].map((c) => c.charCodeAt(0))
);

// help./www. are Webex's own help/marketing hosts, never meeting rooms.
const WEBEX_EXCLUDED_HOSTS = new Set(['help.webex.com', 'www.webex.com']);
// A join-style Webex path: "/meet/<name>", "/join/<name>", or the "j.php" endpoint invite emails use.
function isWebexJoinPath(pathname) {
  return /\/(meet|join)\//i.test(pathname) || pathname.toLowerCase().includes('/j.php');
}

// `url` is already a parsed, https-only URL — only the per-provider host/path shape is judged here.
function isMeetingUrl(url) {
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  if (host === 'teams.microsoft.com' && (pathname.startsWith('/l/meetup-join') || pathname.startsWith('/meet/'))) return true;
  // '/meet/' (with the slash) so '/meetingOptions/...' isn't mistaken for a join link.
  if (host === 'teams.live.com' && pathname.startsWith('/meet/')) return true;
  // Zoom personal/meeting links are also issued on the bare zoom.us domain.
  if ((host === 'zoom.us' || host.endsWith('.zoom.us')) && (pathname.startsWith('/j/') || pathname.startsWith('/my/'))) return true;
  if (host === 'meet.google.com' && pathname.length > 1) return true;
  if ((host === 'webex.com' || host.endsWith('.webex.com')) && !WEBEX_EXCLUDED_HOSTS.has(host) && isWebexJoinPath(pathname)) return true;
  // A room segment is required — the bare homepage is not a meeting.
  if ((host === 'whereby.com' || host.endsWith('.whereby.com')) && pathname.length > 1) return true;
  if (host === 'meet.jit.si' && pathname.length > 1) return true;
  return false;
}

function candidatesIn(text) {
  if (!text) return [];
  return String(text).match(URL_CANDIDATE_RE) || [];
}

// Decodes entities, cuts at the first boundary char, then trims trailing punctuation (e.g. "(...)." in prose).
function cleanCandidate(raw) {
  const decoded = decodeEntitiesOnce(raw);
  const cut = decoded.search(CANDIDATE_BOUNDARY_RE);
  const trimmed = cut === -1 ? decoded : decoded.slice(0, cut);
  return trimEndWhile(trimmed, (code) => TRAILING_PUNCTUATION_CODES.has(code));
}

function parseHttpsUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url : null;
}

// Finds the first https:// meeting-provider URL, searching `location` before raw `description`.
export function findMeetingUrl(location, description) {
  const candidates = [...candidatesIn(capRawText(location)), ...candidatesIn(capRawText(description))];
  for (const raw of candidates) {
    const url = parseHttpsUrl(cleanCandidate(raw));
    if (url && isMeetingUrl(url)) return url.href;
  }
  return null;
}

// ── Cache provider keys ──────────────────────────────────────────────────

// The cache/provider key a unified event belongs to, derived from its id prefix.
export function providerKeyForEvent(ev) {
  const id = String(ev?.id || '');
  if (id.startsWith('ics-')) return `ics:${ev.source || ''}`;
  if (id.startsWith('cdav-')) return `caldav:${ev.source || ''}`;
  if (id.startsWith('ms-')) return 'microsoft';
  if (id.startsWith('g-')) return ev.calId || 'google';
  return ev?.calId || ev?.source || 'unknown';
}

// Same cache/provider key, derived from a getUnifiedEvents `errors` entry.
export function providerKeyForError(err) {
  return typeof err?.provider === 'string' ? err.provider : 'unknown';
}

// ── WidgetEvent mapping ──────────────────────────────────────────────────

// Maps a unified event (server-internal shape) to the WidgetEvent shape the widget API returns.
export function toWidgetEvent(ev, { importantIds, calendarNames } = {}) {
  const ids = importantIds instanceof Set ? importantIds : new Set(importantIds || []);
  const names = calendarNames || {};
  return {
    id: ev.id,
    title: ev.title,
    start: ev.start,
    end: ev.end ?? null,
    allDay: Boolean(ev.allDay),
    calId: ev.calId,
    calendar: names[ev.calId] || ev.source || '',
    color: ev.color,
    location: htmlToPlainText(ev.location),
    notes: htmlToPlainText(ev.description, { maxLen: 4000 }),
    meetingUrl: findMeetingUrl(ev.location, ev.description),
    url: ev.originalUrl || null,
    important: ids.has(ev.id),
  };
}

// Reduces a unified event to the fields a stale cached render needs — applied only where events are written to disk.
// No description/location/originalUrl/caldav* : event bodies must never be persisted.
export function toCachedEvent(ev) {
  return {
    id: ev.id,
    title: ev.title,
    start: ev.start,
    end: ev.end ?? null,
    allDay: Boolean(ev.allDay),
    calId: ev.calId,
    color: ev.color,
    // Kept because providerKeyForEvent() groups ics/caldav events by it (and toWidgetEvent falls back to it for the name).
    source: ev.source,
  };
}

// ── Cache merge ──────────────────────────────────────────────────────────

// Merges a fresh {events, errors} fetch with a range's cache; providers that errored fall back to last-cached events.
export function mergeEventsWithCache(fresh, cachedEntry, nowIso) {
  const freshEvents = fresh?.events || [];
  const freshErrors = fresh?.errors || [];
  const cachedProviders = cachedEntry?.providers || {};

  const grouped = new Map();
  for (const ev of freshEvents) {
    const key = providerKeyForEvent(ev);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(ev);
  }

  const nextProviders = {};
  const events = [];
  for (const [key, evs] of grouped) {
    nextProviders[key] = { syncedAt: nowIso, events: evs };
    events.push(...evs);
  }

  const stale = [];
  let oldestIso = null;
  let oldestMs = null;
  const erroredKeys = new Set(freshErrors.map(providerKeyForError));
  for (const key of erroredKeys) {
    if (grouped.has(key)) continue; // a provider can't both succeed and error this round
    const cached = cachedProviders[key];
    if (!cached) continue; // errored, nothing to fall back to
    nextProviders[key] = cached;
    events.push(...(cached.events || []));
    stale.push({ provider: key, syncedAt: cached.syncedAt });
    const t = Date.parse(cached.syncedAt);
    if (oldestMs === null || t < oldestMs) {
      oldestMs = t;
      oldestIso = cached.syncedAt;
    }
  }

  return {
    events,
    stale,
    syncedAt: oldestMs === null ? nowIso : oldestIso,
    nextEntry: { usedAt: nowIso, providers: nextProviders },
  };
}

// ── Cache pruning ────────────────────────────────────────────────────────

// Keeps at most `maxRanges` entries of a {rangeKey: {usedAt, ...}} map, dropping the least-recently-used first.
export function pruneRanges(ranges, maxRanges = 24) {
  const entries = Object.entries(ranges || {});
  if (entries.length <= maxRanges) return { ...ranges };
  entries.sort((a, b) => (Date.parse(b[1]?.usedAt) || 0) - (Date.parse(a[1]?.usedAt) || 0));
  return Object.fromEntries(entries.slice(0, maxRanges));
}
