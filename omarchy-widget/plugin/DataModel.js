// Pure fetch/cache/settings helpers for CalendarData.qml. Same style rules as CalendarModel.js.

var MS_PER_MIN = 60000
var MS_PER_DAY = 86400000

var DEFAULT_SERVER_URL = "http://127.0.0.1:3000"
var DEFAULT_REMINDERS = ["1d", "15m"]
var DEFAULT_ALL_DAY_TIME = "08:00"

// ---- small shared helpers ---------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value !== ""
}

function stripTrailingSlashes(text) {
  return text.replace(/\/+$/, "")
}

function hasWhitespaceOrControlChars(text) {
  return /[\s\x00-\x1f\x7f]/.test(text)
}

// Minimal "scheme://host" split; not a full URL parser (none is available in this JS subset).
function schemeAndHost(value) {
  if (typeof value !== "string") return null
  var m = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\/?#]+)/)
  if (!m) return null
  if (m[2] === "") return null
  return { scheme: m[1].toLowerCase(), host: m[2] }
}

function clampInteger(value, min, max, fallback) {
  var n = Number(value)
  if (!isFinite(n)) return fallback
  n = Math.round(n)
  if (n < min) return min
  if (n > max) return max
  return n
}

function toTimeMs(value) {
  if (typeof value === "number") return isFinite(value) ? value : NaN
  if (typeof value === "string" && value !== "") {
    var parsed = new Date(value)
    var ms = parsed.getTime()
    if (isFinite(ms)) return ms
  }
  return NaN
}

// ---- URLs --------------------------------------------------------------------

// Gates every link before xdg-open: https only, no whitespace/control chars.
function isSafeHttpsUrl(value) {
  if (typeof value !== "string" || value === "") return false
  if (hasWhitespaceOrControlChars(value)) return false
  var parsed = schemeAndHost(value)
  return !!parsed && parsed.scheme === "https"
}

// Same as isSafeHttpsUrl but also allows http (the server URL defaults to loopback).
function isHttpServerUrl(value) {
  if (typeof value !== "string" || value === "") return false
  if (hasWhitespaceOrControlChars(value)) return false
  var parsed = schemeAndHost(value)
  return !!parsed && (parsed.scheme === "http" || parsed.scheme === "https")
}

function normalizeServerUrl(value) {
  var text = isHttpServerUrl(value) ? String(value) : DEFAULT_SERVER_URL
  return stripTrailingSlashes(text)
}

// "start|end" cache/dedupe key; same "YYYY-MM-DD" strings passed to buildEventsUrl.
function rangeKey(start, end) {
  var s = start === undefined || start === null ? "" : String(start)
  var e = end === undefined || end === null ? "" : String(end)
  return s + "|" + e
}

function buildEventsUrl(serverUrl, start, end) {
  var base = stripTrailingSlashes(String(serverUrl === undefined || serverUrl === null ? "" : serverUrl))
  var s = encodeURIComponent(start === undefined || start === null ? "" : String(start))
  var e = encodeURIComponent(end === undefined || end === null ? "" : String(end))
  return base + "/api/widget/events?start=" + s + "&end=" + e
}

function buildImportantUrl(serverUrl) {
  var base = stripTrailingSlashes(String(serverUrl === undefined || serverUrl === null ? "" : serverUrl))
  return base + "/api/widget/important"
}

// ---- settings ------------------------------------------------------------------

// Reminders stay as raw offset strings; CalendarModel.parseOffsets converts them to ms.
function parseSettings(settings) {
  var input = isPlainObject(settings) ? settings : {}

  var reminders =
    Array.isArray(input.reminders) && input.reminders.length > 0 ? input.reminders.slice() : DEFAULT_REMINDERS.slice()

  return {
    serverUrl: normalizeServerUrl(input.serverUrl),
    calendars: Array.isArray(input.calendars) ? input.calendars.slice() : [],
    reminders: reminders,
    allDayReminderTime: isNonEmptyString(input.allDayReminderTime) ? input.allDayReminderTime : DEFAULT_ALL_DAY_TIME,
    upcomingDays: clampInteger(input.upcomingDays, 1, 60, 30),
    upcomingMax: clampInteger(input.upcomingMax, 1, 20, 5),
    refreshMinutes: clampInteger(input.refreshMinutes, 5, 240, 15)
  }
}

// ---- range cache: merge, dedupe, prune --------------------------------------

function eventDedupeKey(ev) {
  var id = ev && ev.id !== undefined && ev.id !== null ? String(ev.id) : ""
  var start = ev && ev.start !== undefined && ev.start !== null ? String(ev.start) : ""
  return id + "|" + start
}

// Dedups by id+start; the most recently fetched copy of a duplicate wins.
function mergeLoadedRanges(rangesMap) {
  var ranges = isPlainObject(rangesMap) ? rangesMap : {}
  var best = Object.create(null)
  var order = []

  var keys = Object.keys(ranges)
  for (var i = 0; i < keys.length; i++) {
    var range = ranges[keys[i]]
    if (!range) continue
    var fetchedAt = toTimeMs(range.fetchedAt)
    var events = range.data && Array.isArray(range.data.events) ? range.data.events : []

    for (var j = 0; j < events.length; j++) {
      var candidate = events[j]
      if (!candidate) continue
      var dedupeKey = eventDedupeKey(candidate)
      var existing = best[dedupeKey]
      if (!existing) order.push(dedupeKey)
      if (!existing || fetchedAt > existing.fetchedAt) {
        best[dedupeKey] = { fetchedAt: fetchedAt, ev: candidate }
      }
    }
  }

  var out = []
  for (var k = 0; k < order.length; k++) out.push(best[order[k]].ev)
  return out
}

// LRU-evicts by usedAt beyond max, except keys in pinnedKeys (the home range).
function pruneRanges(rangesMap, max, pinnedKeys) {
  var ranges = isPlainObject(rangesMap) ? rangesMap : {}
  var limit = Number(max)
  if (!isFinite(limit) || limit < 0) limit = 0

  var pinned = Object.create(null)
  var pinnedList = Array.isArray(pinnedKeys) ? pinnedKeys : []
  for (var p = 0; p < pinnedList.length; p++) pinned[String(pinnedList[p])] = true

  var keys = Object.keys(ranges)
  var pinnedKeysFound = []
  var otherEntries = []
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    if (pinned[key]) {
      pinnedKeysFound.push(key)
    } else {
      otherEntries.push({ key: key, usedAt: toTimeMs(ranges[key] && ranges[key].usedAt) })
    }
  }
  otherEntries.sort(function (a, b) {
    var aUsed = isFinite(a.usedAt) ? a.usedAt : -Infinity
    var bUsed = isFinite(b.usedAt) ? b.usedAt : -Infinity
    return bUsed - aUsed
  })

  var keep = Object.create(null)
  for (var pk = 0; pk < pinnedKeysFound.length; pk++) keep[pinnedKeysFound[pk]] = true
  var remaining = limit - pinnedKeysFound.length
  for (var oi = 0; oi < otherEntries.length && remaining > 0; oi++) {
    keep[otherEntries[oi].key] = true
    remaining--
  }

  var out = {}
  for (var k2 = 0; k2 < keys.length; k2++) {
    if (keep[keys[k2]]) out[keys[k2]] = ranges[keys[k2]]
  }
  return out
}

// True when missing, or old enough for ensureRange to refetch (boundary age counts as stale).
function isRangeStale(existingRange, nowMs, refreshMinutes) {
  if (!existingRange) return true
  var fetchedAt = Number(existingRange.fetchedAt)
  if (!isFinite(fetchedAt)) return true

  var now = Number(nowMs)
  var maxAgeMs = Number(refreshMinutes) * MS_PER_MIN
  if (!isFinite(now) || !isFinite(maxAgeMs)) return true

  return now - fetchedAt >= maxAgeMs
}

// Returns a new range object with usedAt bumped to nowMs, otherwise unchanged.
function touchUsedAt(range, nowMs) {
  if (!isPlainObject(range)) return range
  var now = Number(nowMs)
  var updated = {}
  var keys = Object.keys(range)
  for (var i = 0; i < keys.length; i++) updated[keys[i]] = range[keys[i]]
  if (isFinite(now)) updated.usedAt = now
  return updated
}

// ---- fetch queue and retry ----------------------------------------------------

// Drops every other queued (not in-flight) range but homeKey when a new one is queued.
function enqueueRange(queue, entry, homeKey) {
  var list = Array.isArray(queue) ? queue : []
  var key = entry && entry.key !== undefined && entry.key !== null ? String(entry.key) : ""
  var home = homeKey === undefined || homeKey === null ? "" : String(homeKey)

  var kept = []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    var itemKey = item && item.key !== undefined && item.key !== null ? String(item.key) : ""
    if (itemKey === home || itemKey === key) kept.push(item)
  }

  var alreadyQueued = false
  for (var j = 0; j < kept.length; j++) {
    if (kept[j] && String(kept[j].key) === key) {
      alreadyQueued = true
      break
    }
  }
  if (!alreadyQueued && key !== "") kept.push(entry)
  return kept
}

var RETRY_STEPS_MS = [30000, 60000, 120000, 300000]

// One-shot retry backoff: 30s, 60s, 120s, 300s, then refreshMinutes (never more).
function retryDelayMs(consecutiveFailures, refreshMinutes) {
  var rm = Number(refreshMinutes)
  var cap = isFinite(rm) && rm > 0 ? rm * MS_PER_MIN : RETRY_STEPS_MS[RETRY_STEPS_MS.length - 1]

  var n = Number(consecutiveFailures)
  if (!isFinite(n) || n < 1) return Math.min(RETRY_STEPS_MS[0], cap)

  var idx = Math.floor(n) - 1
  var delay = idx < RETRY_STEPS_MS.length ? RETRY_STEPS_MS[idx] : cap
  return Math.min(delay, cap)
}

// One count per refresh round: while a retry is scheduled, another failed range leaves it alone.
function nextRetry(consecutiveFailures, retryScheduled, refreshMinutes) {
  var n = Number(consecutiveFailures)
  if (!isFinite(n) || n < 0) n = 0
  n = Math.floor(n)
  if (retryScheduled === true) return { failures: n, schedule: false, delayMs: 0 }
  var failures = n + 1
  return { failures: failures, schedule: true, delayMs: retryDelayMs(failures, refreshMinutes) }
}

// ---- reminder bookkeeping ----------------------------------------------------

// Caps the reminder lookback at 10 min so a resumed machine can't fire a stale backlog.
function reminderSince(lastCheckMs, nowMs) {
  var now = Number(nowMs)
  if (!isFinite(now)) now = 0
  var last = Number(lastCheckMs)
  if (!isFinite(last)) return now - MS_PER_MIN

  var floor = now - 10 * MS_PER_MIN
  if (last < floor) return floor
  if (last > now) return now
  return last
}

// Drops fired-reminder entries older than 3 days so the state file can't grow forever.
function pruneFired(fired, nowMs) {
  var input = isPlainObject(fired) ? fired : {}
  var now = Number(nowMs)
  if (!isFinite(now)) now = 0
  var cutoff = now - 3 * MS_PER_DAY

  var out = {}
  var keys = Object.keys(input)
  for (var i = 0; i < keys.length; i++) {
    var baseMs = Number(input[keys[i]])
    if (isFinite(baseMs) && baseMs >= cutoff) out[keys[i]] = input[keys[i]]
  }
  return out
}

// ---- status text ---------------------------------------------------------------

// ics:/caldav: keys use the name after the prefix; others look up the calendars list by id.
function providerDisplayName(providerKey, calendars) {
  var key = providerKey === undefined || providerKey === null ? "" : String(providerKey)
  var prefixed = key.match(/^(?:ics|caldav):(.+)$/)
  if (prefixed) return prefixed[1]

  for (var i = 0; i < calendars.length; i++) {
    var cal = calendars[i]
    if (cal && String(cal.id) === key) return cal.name !== undefined && cal.name !== null ? String(cal.name) : key
  }
  return key
}

function collectUnavailableNames(stale, errors, calendars) {
  var seen = Object.create(null)
  var out = []
  function add(providerKey) {
    var name = providerDisplayName(providerKey, calendars)
    if (name === "" || seen[name]) return
    seen[name] = true
    out.push(name)
  }
  for (var i = 0; i < stale.length; i++) add(stale[i] && stale[i].provider)
  for (var j = 0; j < errors.length; j++) add(errors[j] && errors[j].provider)
  return out
}

// Builds the short status line shown next to the clock; a failed star save is prefixed.
function composeStatus(input) {
  var data = isPlainObject(input) ? input : {}
  var lastFetchOk = !!data.lastFetchOk
  var serverReachable = data.serverReachable !== false
  var stale = Array.isArray(data.stale) ? data.stale : []
  var errors = Array.isArray(data.errors) ? data.errors : []
  var calendars = Array.isArray(data.calendars) ? data.calendars : []
  var syncedLabel = typeof data.syncedLabel === "string" ? data.syncedLabel : ""

  var parts = data.toggleFailed === true ? ["star not saved"] : []

  if (lastFetchOk && stale.length === 0 && errors.length === 0) return parts.join(" · ")

  if (!serverReachable) {
    parts.push("calendar server unavailable")
    if (syncedLabel !== "") parts.push(syncedLabel)
    return parts.join(" · ")
  }

  var names = collectUnavailableNames(stale, errors, calendars)
  var tail = []
  for (var i = 0; i < names.length; i++) tail.push(names[i] + " unavailable")

  if (syncedLabel !== "") parts.push(syncedLabel)
  if (tail.length > 0) parts.push(tail.join(", "))
  return parts.join(" · ")
}

// ---- reminder notifications ----------------------------------------------------

var REMINDER_GLYPH = "󰃭"

// In this order: Omarchy renders a notification body as StyledText
function escapeStyledText(value) {
  var text = value === undefined || value === null ? "" : String(value)
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// The heading always starts with the time label, so omarchy-notification-send never reads it as an option
function reminderNotification(text, ev, prefix) {
  if (!text || !isNonEmptyString(text.title)) return null
  var label = (typeof prefix === "string" ? prefix : "") + text.title
  if (label.charAt(0) === "-") return null

  var title = String((ev && ev.title) || "").replace(/\s+/g, " ").trim()
  var heading = title !== "" ? label + " · " + title : label
  var argv = ["omarchy-notification-send", "-u", "normal", "-g", REMINDER_GLYPH, heading, escapeStyledText(text.body)]
  var hasMeeting = isSafeHttpsUrl(ev && ev.meetingUrl)
  if (hasMeeting) argv.push("--exec", "xdg-open", ev.meetingUrl)
  return { argv: argv, label: label, hasMeeting: hasMeeting }
}

// ---- instances ----------------------------------------------------------------------

function isPrimaryInstance(peers, self) {
  if (!Array.isArray(peers) || peers.length === 0) return true
  return peers[0] === self
}

// ---- response validation -----------------------------------------------------

// Rejects a malformed response outright; drops individual malformed events instead.
function parseResponse(text) {
  if (typeof text !== "string" || text === "") return null

  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (!isNonEmptyString(parsed.generatedAt)) return null
  if (!isNonEmptyString(parsed.syncedAt)) return null

  var range = parsed.range
  if (!isPlainObject(range)) return null
  if (!isNonEmptyString(range.start) || !isNonEmptyString(range.end)) return null

  if (!Array.isArray(parsed.calendars)) return null
  if (!Array.isArray(parsed.events)) return null
  if (!Array.isArray(parsed.errors)) return null
  if (!Array.isArray(parsed.stale)) return null

  var events = []
  for (var i = 0; i < parsed.events.length; i++) {
    var candidate = parsed.events[i]
    if (candidate && typeof candidate === "object" && isNonEmptyString(candidate.id) && isNonEmptyString(candidate.start)) {
      events.push(candidate)
    }
  }

  return {
    generatedAt: parsed.generatedAt,
    range: { start: range.start, end: range.end },
    calendars: parsed.calendars,
    events: events,
    errors: parsed.errors,
    stale: parsed.stale,
    syncedAt: parsed.syncedAt
  }
}
