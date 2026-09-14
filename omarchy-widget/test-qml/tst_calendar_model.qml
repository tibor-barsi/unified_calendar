// Qt Quick Test smoke test: CalendarModel.js under Qt's own JavaScript engine, not just node:vm.
import QtQuick
import QtTest
import "../plugin/CalendarModel.js" as CalendarModel

TestCase {
  name: "CalendarModel"

  function test_dayKey() {
    var d = new Date(2026, 9, 25)
    compare(CalendarModel.dayKey(d), "2026-10-25")
  }

  function test_eventDayKeys_allDay() {
    var keys = CalendarModel.eventDayKeys({ allDay: true, start: "2026-10-01", end: "2026-10-04" })
    compare(keys.length, 3)
    compare(keys[0], "2026-10-01")
    compare(keys[1], "2026-10-02")
    compare(keys[2], "2026-10-03")
  }

  function test_eventDayKeys_timed() {
    var midnightEnd = CalendarModel.eventDayKeys({
      allDay: false,
      start: "2026-10-01T22:00:00",
      end: "2026-10-02T00:00:00"
    })
    compare(midnightEnd.length, 1)
    compare(midnightEnd[0], "2026-10-01")

    var multiDay = CalendarModel.eventDayKeys({
      allDay: false,
      start: "2026-10-01T09:00:00",
      end: "2026-10-03T17:00:00"
    })
    compare(multiDay.length, 3)
    compare(multiDay[2], "2026-10-03")
  }

  function test_indexByDay() {
    var events = [
      { id: "allday", allDay: true, start: "2026-10-01", end: "2026-10-02", title: "A" },
      { id: "timed", allDay: false, start: "2026-10-01T09:00:00", end: "2026-10-01T10:00:00", title: "B" }
    ]
    var index = CalendarModel.indexByDay(events)
    verify(Array.isArray(index["2026-10-01"]))
    compare(index["2026-10-01"].length, 2)
    // all-day sorts before timed on the same day.
    compare(index["2026-10-01"][0].id, "allday")
    compare(index["2026-10-01"][1].id, "timed")
  }

  function test_dueReminders() {
    var start = new Date(2026, 9, 1, 9, 0, 0)
    var ev = { id: "e1", important: true, allDay: false, start: start.toISOString() }
    var offsets = [15 * 60000]
    var fireAt = start.getTime() - 15 * 60000

    var due = CalendarModel.dueReminders([ev], offsets, "08:00", fireAt - 1000, fireAt, {})
    compare(due.length, 1)
    compare(due[0].ev.id, "e1")
    compare(due[0].offsetMs, 15 * 60000)
    compare(due[0].coveredKeys.length, 1)
    compare(due[0].coveredKeys[0], due[0].key)

    // Already-fired keys are skipped (dedupe).
    var again = CalendarModel.dueReminders([ev], offsets, "08:00", fireAt - 1000, fireAt, {
      [due[0].key]: true
    })
    compare(again.length, 0)
  }

  function test_dueReminders_coveredKeys() {
    // A long gap covering both the 1d and 15m offsets collapses to one entry, covering both keys.
    var start = new Date(2026, 9, 1, 9, 0, 0)
    var day = 86400000
    var min = 60000
    var ev = { id: "long-gap", important: true, allDay: false, start: start.toISOString() }
    var sinceMs = start.getTime() - day - 1000
    var nowMs = start.getTime() - 5 * min

    var due = CalendarModel.dueReminders([ev], [day, 15 * min], "08:00", sinceMs, nowMs, {})
    compare(due.length, 1)
    compare(due[0].offsetMs, 15 * min)
    compare(due[0].coveredKeys.length, 2)
  }

  function test_formatTimeRange() {
    var single = { allDay: false, start: "2026-10-01T09:00:00", end: "2026-10-01T10:30:00" }
    compare(CalendarModel.formatTimeRange(single, "2026-10-01"), "09:00–10:30")

    var allDay = { allDay: true, start: "2026-10-01", end: "2026-10-02" }
    compare(CalendarModel.formatTimeRange(allDay, "2026-10-01"), "All day")

    var multiDay = { allDay: false, start: "2026-10-01T14:00:00", end: "2026-10-03T12:00:00" }
    compare(CalendarModel.formatTimeRange(multiDay, "2026-10-01"), "From 14:00")
    compare(CalendarModel.formatTimeRange(multiDay, "2026-10-02"), "All day")
    compare(CalendarModel.formatTimeRange(multiDay, "2026-10-03"), "Until 12:00")
  }

  function test_reminderText_offsetZero() {
    var ev = { allDay: false, start: "2026-10-01T09:00:00", end: "2026-10-01T10:30:00", location: "" }
    var nowMs = new Date(2026, 9, 1, 9, 0, 0).getTime()
    var text = CalendarModel.reminderText(ev, 0, "08:00", nowMs)
    compare(text.title, "Now")
  }

  function test_reminderText_overdue() {
    var ev = { allDay: false, start: "2026-10-01T09:00:00", end: "2026-10-01T10:00:00", location: "" }
    var start = new Date(2026, 9, 1, 9, 0, 0).getTime()
    var nowMs = start + 3 * 86400000
    var text = CalendarModel.reminderText(ev, 0, "08:00", nowMs)
    compare(text.title, "Overdue")
  }

  function test_clampUpcomingDays() {
    compare(CalendarModel.clampUpcomingDays(30), 30)
    compare(CalendarModel.clampUpcomingDays(0), 1)
    compare(CalendarModel.clampUpcomingDays(365), 60)
    compare(CalendarModel.clampUpcomingDays(NaN), 30)
    compare(CalendarModel.clampUpcomingDays(undefined), 30)
  }

  function test_readableOn() {
    // Real theme data: tokyo-night, miasma, solitude.
    compare(CalendarModel.readableOn("#f7768e", "#1a1b26", "#a9b1d6"), "background")
    compare(CalendarModel.readableOn("#685742", "#222222", "#c2c2b0"), "foreground")
    compare(CalendarModel.readableOn("#565d60", "#101315", "#cacccc"), "foreground")
  }

  function test_filterByCalendars() {
    // A calId literally "__proto__" must be an ordinary key, not the plain object's [[Prototype]] accessor.
    var events = [
      {
        id: "wanted",
        calId: "f1",
        calendar: "Test Calendar",
        allDay: false,
        start: "2026-10-01T09:00:00",
        end: "2026-10-01T10:00:00"
      },
      {
        id: "leaked",
        calId: "__proto__",
        calendar: "Test Calendar",
        allDay: false,
        start: "2026-10-01T09:00:00",
        end: "2026-10-01T10:00:00"
      }
    ]
    var out = CalendarModel.filterByCalendars(events, ["f1"], [])
    compare(out.length, 1)
    compare(out[0].id, "wanted")
  }

  function test_gridRange() {
    var range = CalendarModel.gridRange(2026, 9, 1)
    verify(range.start instanceof Date)
    verify(range.end instanceof Date)
    compare(CalendarModel.dayKey(range.start), "2026-09-28")
    // 6 weeks * 7 days = 42 days between start and end (end exclusive).
    var days = Math.round((range.end.getTime() - range.start.getTime()) / 86400000)
    compare(days, 42)
  }

  function test_reminderText_longLocationStaysFast() {
    var location = "a" + " ".repeat(20000) + "b"
    var ev = {
      start: "2026-10-01T09:00:00",
      end: "2026-10-01T10:30:00",
      location: location
    }
    var nowMs = new Date(2026, 9, 1, 8, 45, 0).getTime()
    var t0 = Date.now()
    var text = CalendarModel.reminderText(ev, 15 * 60000, "08:00", nowMs)
    var elapsed = Date.now() - t0
    compare(text.body.length, "09:00–10:30 · ".length + location.length)
    verify(elapsed < 50)
  }

  function test_intradayHourLabel_roundsRealDelays() {
    var HOUR = 3600000
    var MIN = 60000
    compare(CalendarModel.intradayHourLabel(HOUR - 20 * 1000), "In 1 h")
    compare(CalendarModel.intradayHourLabel(2 * HOUR + 20 * 1000), "In 2 h")
    compare(CalendarModel.intradayHourLabel(59 * MIN + 50 * 1000), "In 1 h")
  }

  function test_homeRange_hugeUpcomingDays() {
    var nowMs = new Date(2026, 9, 15, 12, 0, 0).getTime()
    var range = CalendarModel.homeRange(nowMs, 1, 1e9)
    verify(isFinite(range.end.getTime()))
    var spanDays = Math.round((range.end.getTime() - range.start.getTime()) / 86400000)
    verify(spanDays <= 100)
  }

  function test_dueReminders_resumeCoversOffsetZero() {
    var MIN = 60000
    var DAY = 86400000
    var start = new Date(2026, 9, 1, 9, 0, 0).getTime()
    var ev = { id: "resume-case", important: true, allDay: false, start: new Date(start).toISOString() }
    var offsets = [15 * MIN, 0]
    var nowMs1 = start - 20 * 1000

    var due1 = CalendarModel.dueReminders([ev], offsets, "08:00", start - 2 * DAY, nowMs1, {})
    compare(due1.length, 1)
    compare(due1[0].coveredKeys.length, 2)

    var fired = {}
    for (var i = 0; i < due1[0].coveredKeys.length; i++) fired[due1[0].coveredKeys[i]] = true

    var due2 = CalendarModel.dueReminders([ev], offsets, "08:00", nowMs1, start + 5000, fired)
    compare(due2.length, 0)
  }
}
