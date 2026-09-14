// QML script style: top-level var/function only; no import/export/class/Intl; local dates, "YYYY-MM-DD" keys.

var MS_PER_MIN = 60000
var MS_PER_HOUR = 3600000
var MS_PER_DAY = 86400000
var MAX_DAY_KEYS = 62

var WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

function pad2(value) {
  var n = Number(value)
  return (n < 10 ? "0" : "") + n
}

// ---- day keys and date parsing ---------------------------------------------

function dayKey(date) {
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
}

// "YYYY-MM-DD" -> local midnight; any other string -> parsed as an instant; invalid or not a string -> null.
function parseEventDate(value) {
  if (typeof value !== "string" || value === "") return null

  var m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    var year = parseInt(m[1], 10)
    var month = parseInt(m[2], 10)
    var day = parseInt(m[3], 10)
    var date = new Date(year, month - 1, day)
    // Reject dates the constructor silently rolled over (e.g. 2026-02-30).
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null
    }
    return date
  }

  var parsed = new Date(value)
  var ms = parsed.getTime()
  return isFinite(ms) ? parsed : null
}

function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

// Local-midnight-to-local-midnight day keys, capped at MAX_DAY_KEYS.
function collectDayKeys(firstDay, lastDay) {
  var keys = []
  var cur = localMidnight(firstDay)
  var last = localMidnight(lastDay)
  while (cur.getTime() <= last.getTime() && keys.length < MAX_DAY_KEYS) {
    keys.push(dayKey(cur))
    cur = addDays(cur, 1)
  }
  return keys
}

// First/last local-midnight day an event spans, uncapped (unlike eventDayKeys below).
function eventDaySpan(ev) {
  if (!ev) return null
  var start = parseEventDate(ev.start)
  if (!start) return null
  var hasEnd = ev.end !== undefined && ev.end !== null && ev.end !== ""
  var end = hasEnd ? parseEventDate(ev.end) : null

  if (ev.allDay) {
    var startDay = localMidnight(start)
    var endDay = end ? localMidnight(end) : null
    var lastDay = !endDay || endDay.getTime() <= startDay.getTime() ? startDay : addDays(endDay, -1)
    return { firstDay: startDay, lastDay: lastDay }
  }

  var startDate = localMidnight(start)
  var endDate = end ? localMidnight(end) : startDate
  if (end) {
    var endIsMidnight =
      end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0
    if (endDate.getTime() > startDate.getTime() && endIsMidnight) {
      endDate = addDays(endDate, -1)
    } else if (endDate.getTime() < startDate.getTime()) {
      endDate = startDate
    }
  }
  return { firstDay: startDate, lastDay: endDate }
}

// eventDaySpan's day range, enumerated and capped at MAX_DAY_KEYS keys (for grid/index display only).
function eventDayKeys(ev) {
  var span = eventDaySpan(ev)
  if (!span) return []
  return collectDayKeys(span.firstDay, span.lastDay)
}

// Instant an event ends, for "has this ended?" checks (all-day: midnight after its last day).
function eventEndMs(ev) {
  if (!ev) return null
  var start = parseEventDate(ev.start)
  if (!start) return null

  if (ev.allDay) {
    var span = eventDaySpan(ev)
    return span ? addDays(span.lastDay, 1).getTime() : null
  }

  var hasEnd = ev.end !== undefined && ev.end !== null && ev.end !== ""
  var end = hasEnd ? parseEventDate(ev.end) : null
  return end ? end.getTime() : start.getTime()
}

// ---- calendar filtering and per-day indexing -------------------------------

// setting: array of calendar ids/names (case-insensitive) to keep; missing/empty/non-array means "all".
function filterByCalendars(events, setting, calendars) {
  var list = Array.isArray(events) ? events : []
  if (!Array.isArray(setting) || setting.length === 0) return list.slice()

  // Object.create(null): a calId/name literally "__proto__" must be an ordinary key, not the prototype accessor.
  var wanted = Object.create(null)
  for (var i = 0; i < setting.length; i++) {
    var text = String(setting[i] === undefined || setting[i] === null ? "" : setting[i]).toLowerCase()
    if (text !== "") wanted[text] = true
  }
  if (Object.keys(wanted).length === 0) return list.slice()

  var allowedCalIds = Object.create(null)
  var cals = Array.isArray(calendars) ? calendars : []
  for (var c = 0; c < cals.length; c++) {
    var cal = cals[c] || {}
    var id = String(cal.id === undefined || cal.id === null ? "" : cal.id)
    var name = String(cal.name === undefined || cal.name === null ? "" : cal.name).toLowerCase()
    if (wanted[id.toLowerCase()] || wanted[name]) allowedCalIds[id] = true
  }

  var out = []
  for (var e = 0; e < list.length; e++) {
    var ev = list[e] || {}
    var calId = String(ev.calId === undefined || ev.calId === null ? "" : ev.calId)
    var calName = String(ev.calendar === undefined || ev.calendar === null ? "" : ev.calendar).toLowerCase()
    if (wanted[calId.toLowerCase()] || wanted[calName] || allowedCalIds[calId]) out.push(ev)
  }
  return out
}

function compareEvents(a, b) {
  var aAllDay = a && a.allDay ? 0 : 1
  var bAllDay = b && b.allDay ? 0 : 1
  if (aAllDay !== bAllDay) return aAllDay - bAllDay

  var aStart = parseEventDate(a && a.start)
  var bStart = parseEventDate(b && b.start)
  var aMs = aStart ? aStart.getTime() : 0
  var bMs = bStart ? bStart.getTime() : 0
  if (aMs !== bMs) return aMs - bMs

  var aTitle = String((a && a.title) || "")
  var bTitle = String((b && b.title) || "")
  if (aTitle < bTitle) return -1
  if (aTitle > bTitle) return 1
  return 0
}

// {key: [ev...]}, each list sorted all-day first, then by start, then title.
function indexByDay(events) {
  var list = Array.isArray(events) ? events : []
  var index = {}
  for (var i = 0; i < list.length; i++) {
    var ev = list[i]
    var keys = eventDayKeys(ev)
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k]
      if (!index[key]) index[key] = []
      index[key].push(ev)
    }
  }
  for (var dayKeyName in index) index[dayKeyName].sort(compareEvents)
  return index
}

function dayInfo(index, key, todayKey) {
  var list = (index && index[key]) || []
  var important = false
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].important) {
      important = true
      break
    }
  }
  return {
    key: key,
    count: list.length,
    dots: Math.min(list.length, 3),
    important: important,
    spent: key < todayKey
  }
}

// ---- upcoming / clock mark --------------------------------------------------

// Important, not-ended events starting before nowMs+days, sorted by start; items capped at max, total uncapped.
function upcomingImportant(events, nowMs, days, max) {
  var list = Array.isArray(events) ? events : []
  var daysNum = Number(days)
  if (!isFinite(daysNum) || daysNum < 0) daysNum = 0
  var cutoff = nowMs + daysNum * MS_PER_DAY
  var maxCount = Number(max)
  if (!isFinite(maxCount) || maxCount < 0) maxCount = 0

  var matches = []
  for (var i = 0; i < list.length; i++) {
    var ev = list[i]
    if (!ev || !ev.important) continue
    var start = parseEventDate(ev.start)
    if (!start) continue
    var startMs = start.getTime()
    if (startMs >= cutoff) continue
    var endMs = eventEndMs(ev)
    if (endMs !== null && endMs <= nowMs) continue
    matches.push({ ev: ev, startMs: startMs })
  }
  matches.sort(function (a, b) {
    return a.startMs - b.startMs
  })

  var items = []
  for (var j = 0; j < matches.length && items.length < maxCount; j++) items.push(matches[j].ev)
  return { total: matches.length, items: items }
}

// True when an important event's day span includes today and it hasn't ended yet.
function clockMarkVisible(events, nowMs) {
  var list = Array.isArray(events) ? events : []
  var todayKey = dayKey(new Date(nowMs))
  for (var i = 0; i < list.length; i++) {
    var ev = list[i]
    if (!ev || !ev.important) continue
    var span = eventDaySpan(ev)
    if (!span || todayKey < dayKey(span.firstDay) || todayKey > dayKey(span.lastDay)) continue
    var endMs = eventEndMs(ev)
    if (endMs !== null && endMs <= nowMs) continue
    return true
  }
  return false
}

// ---- reminder offsets and scheduling ----------------------------------------

var DEFAULT_OFFSETS_MS = [86400000, 900000]

// "15m" / "1h" / "1d" / a plain non-negative integer (minutes) -> ms; else null.
function parseOffset(value) {
  var text = String(value === undefined || value === null ? "" : value).trim()
  if (text === "") return null

  var suffixed = text.match(/^(\d+)(m|h|d)$/i)
  if (suffixed) {
    var amount = parseInt(suffixed[1], 10)
    var unit = suffixed[2].toLowerCase()
    var factor = unit === "m" ? MS_PER_MIN : unit === "h" ? MS_PER_HOUR : MS_PER_DAY
    return amount * factor
  }

  if (/^\d+$/.test(text)) return parseInt(text, 10) * MS_PER_MIN
  return null
}

// Unique ms values, descending, invalid entries dropped; empty result falls back to the default offsets.
function parseOffsets(list) {
  var input = Array.isArray(list) ? list : []
  var seen = {}
  var out = []
  for (var i = 0; i < input.length; i++) {
    var ms = parseOffset(input[i])
    if (ms === null || seen[ms]) continue
    seen[ms] = true
    out.push(ms)
  }
  out.sort(function (a, b) {
    return b - a
  })
  return out.length > 0 ? out : DEFAULT_OFFSETS_MS.slice()
}

function parseHHMM(value) {
  var text = String(value === undefined || value === null ? "" : value).trim()
  var m = text.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  var hours = parseInt(m[1], 10)
  var minutes = parseInt(m[2], 10)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return { hours: hours, minutes: minutes }
}

// Timed events reminder off their own start; all-day events off their start day at allDayTime (invalid -> 08:00).
function reminderBase(ev, allDayTime) {
  if (!ev) return null
  var start = parseEventDate(ev.start)
  if (!start) return null
  if (!ev.allDay) return start

  var time = parseHHMM(allDayTime) || { hours: 8, minutes: 0 }
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), time.hours, time.minutes, 0, 0)
}

// Reminders due in (sinceMs, nowMs]; several due offsets collapse to the smallest, per coveredKeys.
function dueReminders(events, offsetsMs, allDayTime, sinceMs, nowMs, firedKeys) {
  var list = Array.isArray(events) ? events : []
  var offsets = Array.isArray(offsetsMs) ? offsetsMs : []
  var fired = firedKeys || {}
  var out = []

  for (var i = 0; i < list.length; i++) {
    var ev = list[i]
    if (!ev || !ev.important) continue
    var base = reminderBase(ev, allDayTime)
    if (!base) continue
    var baseMs = base.getTime()

    var due = []
    for (var j = 0; j < offsets.length; j++) {
      var offsetMs = offsets[j]
      if (offsetMs > 0 && baseMs <= nowMs) continue
      var fireAtMs = baseMs - offsetMs
      if (fireAtMs <= sinceMs || fireAtMs > nowMs) continue
      var key = String(ev.id) + "|" + base.toISOString() + "|" + offsetMs
      if (fired[key]) continue
      due.push({ key: key, offsetMs: offsetMs, fireAtMs: fireAtMs })
    }
    if (due.length === 0) continue

    due.sort(function (a, b) {
      return a.offsetMs - b.offsetMs
    })
    var coveredKeys = []
    for (var k = 0; k < due.length; k++) coveredKeys.push(due[k].key)

    // A positive offset firing under 1 min before start also covers offset 0, so "Now" isn't sent twice.
    var remainingToStart = baseMs - nowMs
    if (offsets.indexOf(0) !== -1 && remainingToStart >= 0 && remainingToStart < MS_PER_MIN) {
      var zeroKey = String(ev.id) + "|" + base.toISOString() + "|0"
      if (coveredKeys.indexOf(zeroKey) === -1) coveredKeys.push(zeroKey)
    }

    var chosen = due[0]
    out.push({
      key: chosen.key,
      ev: ev,
      offsetMs: chosen.offsetMs,
      fireAtMs: chosen.fireAtMs,
      baseMs: baseMs,
      coveredKeys: coveredKeys
    })
  }
  return out
}

// Under 1h: rounded minutes (min 1; 60 bumps to "In 1 h"). From 1h to <24h: rounded whole hours.
function intradayHourLabel(remainingMs) {
  if (remainingMs < MS_PER_HOUR) {
    var minutes = Math.max(1, Math.round(remainingMs / MS_PER_MIN))
    if (minutes >= 60) return "In 1 h"
    return "In " + minutes + " min"
  }
  return "In " + Math.round(remainingMs / MS_PER_HOUR) + " h"
}

// "Today" / "Tomorrow" / "In N days" / "Overdue", comparing targetKey against nowMs's own day.
function dayRelativeLabel(targetKey, nowMs) {
  var todayKey = dayKey(new Date(nowMs))
  if (targetKey === todayKey) return "Today"

  var todayDate = parseEventDate(todayKey)
  var targetDate = parseEventDate(targetKey)
  if (todayDate && targetDate) {
    var diffDays = Math.round((targetDate.getTime() - todayDate.getTime()) / MS_PER_DAY)
    if (diffDays === 1) return "Tomorrow"
    if (diffDays > 1) return "In " + diffDays + " days"
    if (diffDays < 0) return "Overdue"
  }
  return targetKey
}

// Title from time actually left (not the configured offset); overdue past a minute defers to dayRelativeLabel.
function timedRelativeLabel(start, nowMs) {
  var remaining = start.getTime() - nowMs
  var startKey = dayKey(start)
  var todayKey = dayKey(new Date(nowMs))

  if (remaining < 0 && (-remaining >= MS_PER_MIN || startKey !== todayKey)) return dayRelativeLabel(startKey, nowMs)
  if (remaining < MS_PER_MIN) return "Now"
  if (remaining < MS_PER_DAY && startKey === todayKey) return intradayHourLabel(remaining)
  return dayRelativeLabel(startKey, nowMs)
}

// {title, body} for a due reminder notification, e.g. {title: "In 15 min", body: "09:00–10:30 · Room 1"}.
function reminderText(ev, offsetMs, allDayTime, nowMs) {
  var start = ev ? parseEventDate(ev.start) : null
  var title = ""
  var body = ""

  if (start) {
    var startKey = dayKey(start)
    if (ev.allDay) {
      title = dayRelativeLabel(startKey, nowMs)
      body = "All day"
    } else {
      title = timedRelativeLabel(start, nowMs)
      body = formatTimeRange(ev, startKey)
    }
  }

  var location = String((ev && ev.location) || "").trim()
  if (location !== "") body = body === "" ? location : body + " · " + location

  return { title: title, body: body }
}

// ---- display formatting ------------------------------------------------------

function formatHHMM(date) {
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes())
}

// 24h "09:00–10:30" / "All day"; multi-day timed: "From 14:00" first day, "Until 12:00" last, "All day" between.
function formatTimeRange(ev, key) {
  if (!ev) return ""
  if (ev.allDay) return "All day"

  var start = parseEventDate(ev.start)
  if (!start) return ""
  var hasEnd = ev.end !== undefined && ev.end !== null && ev.end !== ""
  var end = hasEnd ? parseEventDate(ev.end) : null

  var span = eventDaySpan(ev)
  if (!span || span.lastDay.getTime() <= span.firstDay.getTime()) {
    return end ? formatHHMM(start) + "–" + formatHHMM(end) : formatHHMM(start)
  }

  var firstKey = dayKey(span.firstDay)
  var lastKey = dayKey(span.lastDay)
  if (key === firstKey) return "From " + formatHHMM(start)
  if (key === lastKey) return "Until " + formatHHMM(end || start)
  return "All day"
}

// "" (invalid) / "synced just now" / "synced N min/h/d ago".
function syncedAgoLabel(syncedAtIso, nowMs) {
  var synced = parseEventDate(syncedAtIso)
  if (!synced) return ""

  var diff = nowMs - synced.getTime()
  if (diff < 0) diff = 0
  if (diff < MS_PER_MIN) return "synced just now"
  if (diff < MS_PER_HOUR) return "synced " + Math.floor(diff / MS_PER_MIN) + " min ago"
  if (diff < MS_PER_DAY) return "synced " + Math.floor(diff / MS_PER_HOUR) + " h ago"
  return "synced " + Math.floor(diff / MS_PER_DAY) + " d ago"
}

// ---- WCAG contrast -----------------------------------------------------------

// Accepts #rgb, #rrggbb, #aarrggbb (alpha-first, Qt order); alpha is ignored.
function parseHexColor(hex) {
  var text = String(hex === undefined || hex === null ? "" : hex).trim()
  var m = text.match(/^#([0-9a-fA-F]+)$/)
  if (!m) return null
  var digits = m[1]
  var r, g, b

  if (digits.length === 3) {
    r = parseInt(digits.charAt(0) + digits.charAt(0), 16)
    g = parseInt(digits.charAt(1) + digits.charAt(1), 16)
    b = parseInt(digits.charAt(2) + digits.charAt(2), 16)
  } else if (digits.length === 6) {
    r = parseInt(digits.substr(0, 2), 16)
    g = parseInt(digits.substr(2, 2), 16)
    b = parseInt(digits.substr(4, 2), 16)
  } else if (digits.length === 8) {
    r = parseInt(digits.substr(2, 2), 16)
    g = parseInt(digits.substr(4, 2), 16)
    b = parseInt(digits.substr(6, 2), 16)
  } else {
    return null
  }

  if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null
  return { r: r, g: g, b: b }
}

function channelLuminance(value) {
  var c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex) {
  var rgb = parseHexColor(hex)
  if (!rgb) return null
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b)
}

function contrastRatio(a, b) {
  var la = relativeLuminance(a)
  var lb = relativeLuminance(b)
  if (la === null || lb === null) return null
  var lighter = Math.max(la, lb)
  var darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

// Whichever of backgroundHex/foregroundHex contrasts more with fillHex.
function readableOn(fillHex, backgroundHex, foregroundHex) {
  var bgRatio = contrastRatio(fillHex, backgroundHex)
  var fgRatio = contrastRatio(fillHex, foregroundHex)
  if (bgRatio === null && fgRatio === null) return null
  if (bgRatio === null) return "foreground"
  if (fgRatio === null) return "background"
  return fgRatio > bgRatio ? "foreground" : "background"
}

// ---- month grid (mirrors Omarchy's Model.monthGrid) and home range --------

function coerceWeekStart(value) {
  if (value === undefined || value === null) return null
  if (typeof value === "number") return isFinite(value) ? ((Math.round(value) % 7) + 7) % 7 : null

  var text = String(value).trim().toLowerCase()
  if (text === "") return null
  for (var i = 0; i < WEEKDAY_NAMES.length; i++) {
    if (WEEKDAY_NAMES[i] === text || WEEKDAY_NAMES[i].substr(0, 3) === text) return i
  }
  var parsed = parseInt(text, 10)
  return isFinite(parsed) ? ((parsed % 7) + 7) % 7 : null
}

function normalizedWeekStart(value, fallback) {
  var configured = coerceWeekStart(value)
  if (configured !== null) return configured
  var fallbackStart = coerceWeekStart(fallback)
  return fallbackStart === null ? 1 : fallbackStart
}

// {start, end} of the 6-week (42-day) grid, end exclusive -- matches Omarchy's own Model.monthGrid.
function gridRange(viewYear, viewMonth, weekStart) {
  var start = normalizedWeekStart(weekStart, 1)
  var leading = (new Date(viewYear, viewMonth, 1).getDay() - start + 7) % 7
  var gridStart = new Date(viewYear, viewMonth, 1 - leading)
  var gridEnd = addDays(gridStart, 42)
  return { start: gridStart, end: gridEnd }
}

// Integer 1..60 (the widget's upcomingDays setting); 30 for anything that isn't a usable finite number.
function clampUpcomingDays(value) {
  var n = Number(value)
  if (!isFinite(n)) return 30
  var rounded = Math.round(n)
  if (rounded < 1) return 1
  if (rounded > 60) return 60
  return rounded
}

// Union of the current month's grid and today..today+upcomingDays+1, truncated to a 100-day span (start stays the grid start).
function homeRange(nowMs, weekStart, upcomingDays) {
  var now = new Date(nowMs)
  var grid = gridRange(now.getFullYear(), now.getMonth(), weekStart)
  var start = grid.start

  var todayStart = localMidnight(now)
  var days = Number(upcomingDays)
  if (!isFinite(days) || days < 0) days = 0
  if (days > 100) days = 100 // keep addDays' arithmetic in Date's valid range
  var todayEnd = addDays(todayStart, days + 1)

  var end = grid.end.getTime() > todayEnd.getTime() ? grid.end : todayEnd
  var maxEnd = addDays(start, 100)
  if (end.getTime() > maxEnd.getTime()) end = maxEnd
  return { start: start, end: end }
}

// ---- keyboard navigation -----------------------------------------------------

var NAV_UNITS = ["day", "week", "month", "year", "none"]

// hjkl walk the grid a day and a week at a time; the arrow keys keep the
// coarse steps they have on Omarchy's own clock, so the two families cover
// the whole calendar without either one needing a modifier.
var DEFAULT_NAV_KEYS = {
  letters: { horizontal: "day", vertical: "week" },
  arrows: { horizontal: "month", vertical: "year" }
}

function coerceNavUnit(value, fallback) {
  var text = typeof value === "string" ? value.trim().toLowerCase() : ""
  return NAV_UNITS.indexOf(text) === -1 ? fallback : text
}

function coerceNavPair(value, fallback) {
  var input = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  return {
    horizontal: coerceNavUnit(input.horizontal, fallback.horizontal),
    vertical: coerceNavUnit(input.vertical, fallback.vertical)
  }
}

// Each key family gets a unit per axis. An unrecognised unit falls back to
// that slot's default rather than to "none": a typo in shell.json should
// leave the key working, not silently dead.
function parseNavKeys(value) {
  var input = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  return {
    letters: coerceNavPair(input.letters, DEFAULT_NAV_KEYS.letters),
    arrows: coerceNavPair(input.arrows, DEFAULT_NAV_KEYS.arrows)
  }
}

// Where the day cursor appears on the first keypress: today when today is on
// screen, otherwise the 1st of the month being browsed — so summoning the
// cursor never yanks the view back to the current month.
function cursorSeed(todayKey, viewYear, viewMonth) {
  var today = parseEventDate(todayKey)
  if (today && today.getFullYear() === viewYear && today.getMonth() === viewMonth) return todayKey
  return dayKey(new Date(viewYear, viewMonth, 1))
}

// "" for anything that cannot move: an unparseable key, a zero step, or the
// "none" unit.
function stepDayKey(key, unit, delta) {
  var date = parseEventDate(key)
  var step = Number(delta)
  if (!date || !isFinite(step) || step === 0) return ""

  if (unit === "day") return dayKey(addDays(date, step))
  if (unit === "week") return dayKey(addDays(date, step * 7))
  if (unit !== "month" && unit !== "year") return ""

  // Clamp into the target month instead of letting Date roll over: a step
  // from 31 March lands on the 28th/29th of February, not the 2nd of March.
  var months = unit === "year" ? step * 12 : step
  var target = new Date(date.getFullYear(), date.getMonth() + months, 1)
  var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return dayKey(new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay)))
}

// What a navigation key does, given what is selected:
//   "none"   nothing moves
//   "seed"   no cursor yet and a fine unit was pressed — put it on screen first
//   "cursor" move the selected day by `unit`
//   "view"   no cursor, coarse unit — step the month grid, as the stock clock does
function navAction(unit, delta, hasSelection) {
  var step = Number(delta)
  if (!isFinite(step) || step === 0 || unit === "none") return { kind: "none", months: 0 }
  if (NAV_UNITS.indexOf(unit) === -1) return { kind: "none", months: 0 }

  var fine = unit === "day" || unit === "week"
  if (hasSelection) return { kind: "cursor", months: 0 }
  if (fine) return { kind: "seed", months: 0 }
  return { kind: "view", months: unit === "year" ? step * 12 : step }
}

// ---- important flag ----------------------------------------------------------

// New array; only the event whose id matches gets a (new) object with `important` replaced.
function setImportant(events, id, flag) {
  var list = Array.isArray(events) ? events : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var ev = list[i]
    if (ev && ev.id === id) {
      var copy = {}
      for (var key in ev) copy[key] = ev[key]
      copy.important = !!flag
      out.push(copy)
    } else {
      out.push(ev)
    }
  }
  return out
}
