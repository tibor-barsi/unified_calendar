// Qt Quick Test smoke test: proves DataModel.js behaves the same under Qt's own JS engine, not just node:vm.
import QtQuick
import QtTest
import "../plugin/DataModel.js" as DataModel

TestCase {
  name: "DataModel"

  function test_rangeKey() {
    compare(DataModel.rangeKey("2026-10-01", "2026-10-08"), "2026-10-01|2026-10-08")
  }

  function test_buildEventsUrl() {
    compare(
      DataModel.buildEventsUrl("http://127.0.0.1:3000/", "2026-10-01", "2026-10-08"),
      "http://127.0.0.1:3000/api/widget/events?start=2026-10-01&end=2026-10-08"
    )
  }

  function test_buildImportantUrl() {
    compare(DataModel.buildImportantUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000/api/widget/important")
  }

  function test_isSafeHttpsUrl() {
    compare(DataModel.isSafeHttpsUrl("https://meet.google.com/abc-defg-hij"), true)
    compare(DataModel.isSafeHttpsUrl("http://meet.google.com/abc-defg-hij"), false)
    compare(DataModel.isSafeHttpsUrl("https://example.com/ path"), false)
  }

  function test_parseSettings_defaults() {
    var parsed = DataModel.parseSettings({})
    compare(parsed.serverUrl, "http://127.0.0.1:3000")
    compare(parsed.upcomingDays, 30)
    compare(parsed.upcomingMax, 5)
    compare(parsed.refreshMinutes, 15)
    compare(parsed.reminders.length, 2)
  }

  function test_parseSettings_clamps() {
    var parsed = DataModel.parseSettings({ upcomingDays: 0, upcomingMax: 999, refreshMinutes: 1 })
    compare(parsed.upcomingDays, 1)
    compare(parsed.upcomingMax, 20)
    compare(parsed.refreshMinutes, 5)
  }

  function test_mergeLoadedRanges() {
    var ranges = {
      old: { fetchedAt: 1000, usedAt: 1000, data: { events: [{ id: "x", start: "2026-10-01T09:00:00", title: "Stale" }] } },
      fresh: { fetchedAt: 2000, usedAt: 2000, data: { events: [{ id: "x", start: "2026-10-01T09:00:00", title: "Fresh" }] } }
    }
    var out = DataModel.mergeLoadedRanges(ranges)
    compare(out.length, 1)
    compare(out[0].title, "Fresh")
  }

  function test_pruneRanges() {
    var ranges = { home: { usedAt: 1 }, a: { usedAt: 5000 }, b: { usedAt: 4000 } }
    var out = DataModel.pruneRanges(ranges, 2, ["home"])
    verify(!!out.home)
    verify(!!out.a)
    verify(!out.b)
  }

  function test_isRangeStale() {
    var now = new Date(2026, 9, 1, 9, 0, 0).getTime()
    compare(DataModel.isRangeStale(null, now, 15), true)
    compare(DataModel.isRangeStale({ fetchedAt: now - 5 * 60000 }, now, 15), false)
    compare(DataModel.isRangeStale({ fetchedAt: now - 15 * 60000 }, now, 15), true)
  }

  function test_reminderSince() {
    var now = new Date(2026, 9, 1, 9, 0, 0).getTime()
    compare(DataModel.reminderSince(now - 3600000, now), now - 10 * 60000)
  }

  function test_pruneFired() {
    var now = new Date(2026, 9, 10, 0, 0, 0).getTime()
    var fired = { old: now - 4 * 86400000, recent: now - 86400000 }
    var out = DataModel.pruneFired(fired, now)
    verify(!out.old)
    verify(out.recent === now - 86400000)
  }

  function test_composeStatus() {
    compare(
      DataModel.composeStatus({ lastFetchOk: true, serverReachable: true, stale: [], errors: [], calendars: [], syncedLabel: "synced just now" }),
      ""
    )
    compare(
      DataModel.composeStatus({ lastFetchOk: false, serverReachable: false, stale: [], errors: [], calendars: [], syncedLabel: "synced 3 h ago" }),
      "calendar server unavailable · synced 3 h ago"
    )
  }

  function test_parseResponse() {
    var text = JSON.stringify({
      generatedAt: "2026-10-01T09:00:00.000Z",
      range: { start: "2026-10-01", end: "2026-10-08" },
      calendars: [],
      events: [{ id: "e1", start: "2026-10-01T09:00:00.000Z" }],
      errors: [],
      stale: [],
      syncedAt: "2026-10-01T09:00:00.000Z"
    })
    var out = DataModel.parseResponse(text)
    verify(out !== null)
    compare(out.events.length, 1)
    compare(DataModel.parseResponse("not json"), null)
  }

  function test_composeStatus_toggleFailed() {
    compare(
      DataModel.composeStatus({ lastFetchOk: false, serverReachable: false, stale: [], errors: [], calendars: [], syncedLabel: "synced 3 h ago", toggleFailed: true }),
      "star not saved · calendar server unavailable · synced 3 h ago"
    )
  }

  function test_escapeStyledText() {
    compare(DataModel.escapeStyledText("<Room 5> & Co"), "&lt;Room 5&gt; &amp; Co")
  }

  function test_reminderNotification() {
    var ev = { id: "e1", title: "  Design\nreview ", start: "2026-10-01T09:00:00", meetingUrl: "https://meet.google.com/abc-defg-hij" }
    var out = DataModel.reminderNotification({ title: "In 15 min", body: "09:00–10:30 · <Room 5>" }, ev, "Test: ")
    compare(out.argv.slice(0, 5).join(" "), "omarchy-notification-send -u normal -g 󰃭")
    compare(out.argv[5], "Test: In 15 min · Design review")
    compare(out.argv[6], "09:00–10:30 · &lt;Room 5&gt;")
    compare(out.argv.slice(7).join(" "), "--exec xdg-open https://meet.google.com/abc-defg-hij")
    compare(out.label, "Test: In 15 min")
    compare(out.hasMeeting, true)
    compare(DataModel.reminderNotification({ title: "", body: "" }, ev, "Test: "), null)
  }

  QtObject { id: peerA }
  QtObject { id: peerB }

  function test_isPrimaryInstance() {
    compare(DataModel.isPrimaryInstance([peerA, peerB], peerA), true)
    compare(DataModel.isPrimaryInstance([peerA, peerB], peerB), false)
    compare(DataModel.isPrimaryInstance([], peerB), true)
  }

  function test_retryDelayMs() {
    compare(DataModel.retryDelayMs(1, 15), 30000)
    compare(DataModel.retryDelayMs(4, 15), 300000)
    compare(DataModel.retryDelayMs(5, 15), 15 * 60000)
    compare(DataModel.retryDelayMs(0, 15), 30000)
  }

  function test_nextRetry() {
    var first = DataModel.nextRetry(0, false, 15)
    compare(first.failures, 1)
    compare(first.schedule, true)
    compare(first.delayMs, 30000)
    var sameRound = DataModel.nextRetry(first.failures, true, 15)
    compare(sameRound.failures, 1)
    compare(sameRound.schedule, false)
    compare(DataModel.nextRetry(1, false, 15).delayMs, 60000)
  }

  function test_enqueueRange() {
    var home = { start: "2026-10-01", end: "2026-11-12", key: "home" }
    var stale = { start: "2026-09-01", end: "2026-10-13", key: "sep" }
    var fresh = { start: "2026-11-01", end: "2026-12-13", key: "nov" }
    var out = DataModel.enqueueRange([home, stale], fresh, "home")
    compare(out.length, 2)
    compare(out[0].key, "home")
    compare(out[1].key, "nov")
  }

  function test_touchUsedAt() {
    var range = { fetchedAt: 1000, usedAt: 1000 }
    var out = DataModel.touchUsedAt(range, 5000)
    compare(out.usedAt, 5000)
    compare(out.fetchedAt, 1000)
    compare(range.usedAt, 1000)
  }
}
