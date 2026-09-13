process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToPlainText,
  findMeetingUrl,
  providerKeyForEvent,
  providerKeyForError,
  toWidgetEvent,
  toCachedEvent,
  mergeEventsWithCache,
  pruneRanges,
} from '../src/widget.js';
import { makeEvent } from '../test-support/widget-fixtures.js';

// ── htmlToPlainText ─────────────────────────────────────────────

test('htmlToPlainText: empty/null input yields empty string', () => {
  assert.equal(htmlToPlainText(''), '');
  assert.equal(htmlToPlainText(null), '');
  assert.equal(htmlToPlainText(undefined), '');
});

test('htmlToPlainText: plain text without markup is left alone (aside from trim)', () => {
  assert.equal(htmlToPlainText('  arrive <5 min late>  '), 'arrive <5 min late>');
});

test('htmlToPlainText: decodes named entities in plain text', () => {
  assert.equal(htmlToPlainText('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(htmlToPlainText('&lt;not html&gt;'), '<not html>');
  assert.equal(htmlToPlainText('&quot;quoted&quot; &apos;text&apos;'), '"quoted" \'text\'');
});

test('htmlToPlainText: decodes decimal and hex numeric entities', () => {
  assert.equal(htmlToPlainText('&#65;&#66;&#67;'), 'ABC');
  assert.equal(htmlToPlainText('&#x41;&#x42;&#x43;'), 'ABC');
});

test('htmlToPlainText: decodes nbsp to a literal non-breaking space', () => {
  assert.equal(htmlToPlainText('a&nbsp;b'), 'a b');
});

test('htmlToPlainText: strips block tags to newlines (adjacent paragraphs get a blank line between them, since each </p> and <p> occurrence is its own newline)', () => {
  const raw = '<p>Line one</p><p>Line two</p>';
  assert.equal(htmlToPlainText(raw), 'Line one\n\nLine two');
});

test('htmlToPlainText: a single paragraph produces no stray surrounding newlines', () => {
  assert.equal(htmlToPlainText('<p>Solo line</p>'), 'Solo line');
});

test('htmlToPlainText: <br> becomes a newline', () => {
  assert.equal(htmlToPlainText('First<br>Second<br/>Third'), 'First\nSecond\nThird');
});

test('htmlToPlainText: <li> becomes a bullet, list items land on separate lines', () => {
  const raw = '<ul><li>Alpha</li><li>Beta</li></ul>';
  assert.equal(htmlToPlainText(raw), '• Alpha\n• Beta');
});

test('htmlToPlainText: inline tags (a, b, span) are stripped but their text kept', () => {
  const raw = 'Call <b>Jane</b> or see <a href="https://example.com">the doc</a>.';
  assert.equal(htmlToPlainText(raw), 'Call Jane or see the doc.');
});

test('htmlToPlainText: script/style/head/title are dropped along with their content', () => {
  const raw = '<div>Keep</div><script>evil()</script><style>.x{}</style>';
  assert.equal(htmlToPlainText(raw), 'Keep');
});

test('htmlToPlainText: an unclosed style block earlier does not stop a later well-formed script block from being dropped', () => {
  const raw = '<b>x</b><style>broken (no closing style tag) ... <script>alert(1)</script>';
  assert.ok(!htmlToPlainText(raw).includes('alert(1)'));
});

test('htmlToPlainText: entity-encoded HTML is decoded then processed as markup', () => {
  const raw = '&lt;p&gt;Hi &amp; bye&lt;/p&gt;';
  assert.equal(htmlToPlainText(raw), 'Hi & bye');
});

// Real HTML mixed with an escaped tag-like example (e.g. "type <br>") must keep that example literal.
test('htmlToPlainText: real HTML containing an escaped tag-like example keeps that example as literal text', () => {
  const raw = '<p>Use the tag &lt;br&gt; for line breaks.</p>';
  assert.equal(htmlToPlainText(raw), 'Use the tag <br> for line breaks.');
});

test('htmlToPlainText: real HTML containing an escaped &lt;li&gt; example does not turn into a spurious bullet', () => {
  const raw = '<p>Type &lt;li&gt;Item&lt;/li&gt; to add a list entry.</p>';
  assert.equal(htmlToPlainText(raw), 'Type <li>Item</li> to add a list entry.');
});

test('htmlToPlainText: drops separator-only lines (>=5 of _-=*~)', () => {
  const raw = 'Before\n-----\nAfter\n=====\nEnd\n*****';
  assert.equal(htmlToPlainText(raw), 'Before\nAfter\nEnd');
});

test('htmlToPlainText: keeps a run of fewer than 5 separator characters', () => {
  assert.equal(htmlToPlainText('Before\n***\nAfter'), 'Before\n***\nAfter');
});

test('htmlToPlainText: keeps short dash runs that are not separator lines', () => {
  assert.equal(htmlToPlainText('a - b'), 'a - b');
});

test('htmlToPlainText: collapses 3+ blank-line runs to a single blank line', () => {
  const raw = 'One\n\n\n\n\nTwo';
  assert.equal(htmlToPlainText(raw), 'One\n\nTwo');
});

test('htmlToPlainText: trims trailing whitespace from each line', () => {
  const raw = '<p>One   </p><p>Two\t</p>';
  assert.equal(htmlToPlainText(raw), 'One\n\nTwo');
});

test('htmlToPlainText: overall result is trimmed', () => {
  assert.equal(htmlToPlainText('<p></p><p>  Hello  </p><p></p>'), 'Hello');
});

test('htmlToPlainText: truncates to maxLen with an ellipsis', () => {
  const raw = 'x'.repeat(4010);
  const out = htmlToPlainText(raw, { maxLen: 4000 });
  assert.equal(out.length, 4000);
  assert.ok(out.endsWith('…'));
  assert.equal(out.slice(0, 10), 'x'.repeat(10));
});

test('htmlToPlainText: no truncation when under maxLen', () => {
  const raw = 'short text';
  assert.equal(htmlToPlainText(raw, { maxLen: 4000 }), 'short text');
});

test('htmlToPlainText: no cap applied when maxLen is not given', () => {
  const raw = 'y'.repeat(5000);
  assert.equal(htmlToPlainText(raw).length, 5000);
});

// ── out-of-range numeric entities: degrade gracefully, never throw ──

test('htmlToPlainText: an out-of-range hex numeric entity (just past 0x10FFFF) is kept literal, not thrown', () => {
  assert.equal(htmlToPlainText('Before &#x110000; After'), 'Before &#x110000; After');
});

test('htmlToPlainText: an out-of-range decimal numeric entity (1114112 = 0x110000) is kept literal, not thrown', () => {
  assert.equal(htmlToPlainText('Before &#1114112; After'), 'Before &#1114112; After');
});

test('htmlToPlainText: a huge decimal numeric entity is kept literal, not thrown', () => {
  assert.equal(htmlToPlainText('Before &#99999999999; After'), 'Before &#99999999999; After');
});

test('htmlToPlainText: the max valid hex numeric entity (0x10FFFF) still decodes normally', () => {
  assert.equal(htmlToPlainText('&#x10FFFF;'), String.fromCodePoint(0x10ffff));
});

test('htmlToPlainText: a NUL code point entity (&#0;) is kept literal, not decoded', () => {
  assert.equal(htmlToPlainText('Before &#0; After'), 'Before &#0; After');
});

test('htmlToPlainText: a lone-surrogate entity (&#xD800;) is kept literal, not decoded', () => {
  assert.equal(htmlToPlainText('Before &#xD800; After'), 'Before &#xD800; After');
  assert.equal(htmlToPlainText('Before &#57343; After'), 'Before &#57343; After'); // 0xDFFF
});

test('htmlToPlainText: a table cell boundary reads as a space, not nothing', () => {
  assert.equal(htmlToPlainText('<td>Meeting ID:</td><td>123</td>'), 'Meeting ID: 123');
  assert.equal(htmlToPlainText('<tr><th>Room</th><th>Time</th></tr>'), 'Room Time');
});

// ── findMeetingUrl ──────────────────────────────────────────────

test('findMeetingUrl: finds a Teams meetup-join link in the description', () => {
  const desc = 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d';
  assert.equal(
    findMeetingUrl('', desc),
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d'
  );
});

test('findMeetingUrl: finds a Zoom /j/ link', () => {
  assert.equal(findMeetingUrl('', 'https://us02web.zoom.us/j/1234567890?pwd=abc'),
    'https://us02web.zoom.us/j/1234567890?pwd=abc');
});

test('findMeetingUrl: finds a Zoom /my/ personal-room link', () => {
  assert.equal(findMeetingUrl('', 'https://company.zoom.us/my/jane.doe'),
    'https://company.zoom.us/my/jane.doe');
});

test('findMeetingUrl: finds a Google Meet link', () => {
  assert.equal(findMeetingUrl('', 'Join at https://meet.google.com/abc-defg-hij'),
    'https://meet.google.com/abc-defg-hij');
});

test('findMeetingUrl: finds a Webex link', () => {
  assert.equal(findMeetingUrl('', 'https://company.webex.com/meet/jane'),
    'https://company.webex.com/meet/jane');
});

test('findMeetingUrl: finds a Whereby link', () => {
  assert.equal(findMeetingUrl('', 'https://whereby.com/my-room'), 'https://whereby.com/my-room');
});

test('findMeetingUrl: finds a Jitsi link', () => {
  assert.equal(findMeetingUrl('', 'https://meet.jit.si/SomeRoomName'), 'https://meet.jit.si/SomeRoomName');
});

test('findMeetingUrl: prefers a match in location over description', () => {
  const location = 'https://meet.google.com/loc-atio-nxx';
  const description = 'https://meet.google.com/desc-ript-ion';
  assert.equal(findMeetingUrl(location, description), 'https://meet.google.com/loc-atio-nxx');
});

test('findMeetingUrl: ignores non-meeting https links and returns null', () => {
  assert.equal(findMeetingUrl('', 'See https://example.com/agenda.pdf for details'), null);
});

test('findMeetingUrl: ignores http (non-https) meeting-looking links', () => {
  assert.equal(findMeetingUrl('', 'http://meet.jit.si/insecure'), null);
});

test('findMeetingUrl: returns null for empty/missing fields', () => {
  assert.equal(findMeetingUrl('', ''), null);
  assert.equal(findMeetingUrl(null, undefined), null);
});

test('findMeetingUrl: decodes &amp; inside the URL', () => {
  const desc = 'https://us02web.zoom.us/j/123?pwd=a&amp;b=2';
  assert.equal(findMeetingUrl('', desc), 'https://us02web.zoom.us/j/123?pwd=a&b=2');
});

test('findMeetingUrl: strips trailing punctuation picked up from surrounding prose', () => {
  const desc = 'Join here (https://meet.google.com/abc-defg-hij).';
  assert.equal(findMeetingUrl('', desc), 'https://meet.google.com/abc-defg-hij');
});

test('findMeetingUrl: finds a link inside a raw href attribute', () => {
  const desc = '<a href="https://teams.live.com/meet/12345?p=x">Join Teams</a>';
  assert.equal(findMeetingUrl('', desc), 'https://teams.live.com/meet/12345?p=x');
});

// ── additional provider path edge cases ──────────────────────────

test('findMeetingUrl: finds a bare zoom.us /j/ link with no subdomain', () => {
  assert.equal(findMeetingUrl('', 'https://zoom.us/j/1234567890'), 'https://zoom.us/j/1234567890');
});

test('findMeetingUrl: finds a bare zoom.us /my/ link with no subdomain', () => {
  assert.equal(findMeetingUrl('', 'https://zoom.us/my/jane.doe'), 'https://zoom.us/my/jane.doe');
});

test('findMeetingUrl: finds the newer Teams /meet/ link format', () => {
  const desc = 'Join: https://teams.microsoft.com/meet/123456789?p=abcXYZ';
  assert.equal(findMeetingUrl('', desc), 'https://teams.microsoft.com/meet/123456789?p=abcXYZ');
});

test('findMeetingUrl: ignores a Webex help-center article link (help. host, no join path)', () => {
  assert.equal(findMeetingUrl('', 'See https://help.webex.com/en-us/article/123'), null);
});

test('findMeetingUrl: ignores the bare Webex marketing site (www. host)', () => {
  assert.equal(findMeetingUrl('', 'https://www.webex.com'), null);
});

test('findMeetingUrl: ignores a webex.com subdomain link with no join-style path', () => {
  assert.equal(findMeetingUrl('', 'https://company.webex.com/team/announcements'), null);
});

test('findMeetingUrl: accepts a Webex j.php join link', () => {
  const url = 'https://company.webex.com/webappng/sites/company/j.php?MTID=abc123';
  assert.equal(findMeetingUrl('', url), url);
});

test('findMeetingUrl: ignores a bare Whereby homepage link with no room segment', () => {
  assert.equal(findMeetingUrl('', 'https://whereby.com'), null);
});

test('findMeetingUrl: an entity-decoded trailing NBSP is not left on the URL', () => {
  const desc = 'https://teams.microsoft.com/l/meetup-join/abc&nbsp;<br>';
  const url = findMeetingUrl('', desc);
  assert.equal(url, 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.ok(!url.endsWith(' '));
});

test('findMeetingUrl: an entity-decoded space cuts the candidate short', () => {
  assert.equal(findMeetingUrl('', 'https://acme.zoom.us/j/1&#32;--foo'), 'https://acme.zoom.us/j/1');
});

test('findMeetingUrl: an entity-decoded newline is not embedded in the URL', () => {
  const url = findMeetingUrl('', 'https://meet.jit.si/room&#10;xyz');
  assert.equal(url, 'https://meet.jit.si/room');
  assert.ok(!url.includes('\n'));
});

test('findMeetingUrl: rejects teams.live.com/meetingOptions (not a real /meet/ path)', () => {
  assert.equal(findMeetingUrl('', 'https://teams.live.com/meetingOptions/abc'), null);
});

test('findMeetingUrl: rejects a bare meet.jit.si with no room', () => {
  assert.equal(findMeetingUrl('', 'https://meet.jit.si'), null);
});

test('findMeetingUrl: rejects meet.jit.si with just a trailing slash', () => {
  assert.equal(findMeetingUrl('', 'https://meet.jit.si/'), null);
});

test('findMeetingUrl: entity-encoded HTML href does not leak encoded closing markup into the URL', () => {
  const desc =
    '&lt;a href=&quot;https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d&quot;&gt;Join&lt;/a&gt;';
  assert.equal(
    findMeetingUrl('', desc),
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=%7b%7d'
  );
});

// ── providerKeyForEvent / providerKeyForError ──────────────────

test('providerKeyForEvent: ics event keyed by "ics:<source>"', () => {
  const ev = makeEvent({ id: 'ics-f1-uid-2026-09-15T09:00:00.000Z', source: 'Outlook', calId: 'f1' });
  assert.equal(providerKeyForEvent(ev), 'ics:Outlook');
});

test('providerKeyForEvent: caldav event keyed by "caldav:<source>"', () => {
  const ev = makeEvent({ id: 'cdav-uid123', source: 'Personal CalDAV', calId: 'cdav_1_cal' });
  assert.equal(providerKeyForEvent(ev), 'caldav:Personal CalDAV');
});

test('providerKeyForEvent: microsoft event keyed by the constant "microsoft"', () => {
  const ev = makeEvent({ id: 'ms-AAA', source: 'Outlook', calId: 'microsoft' });
  assert.equal(providerKeyForEvent(ev), 'microsoft');
});

test('providerKeyForEvent: google event keyed by its calId', () => {
  const ev = makeEvent({ id: 'g-xyz', source: 'Google', calId: 'gcal_primary' });
  assert.equal(providerKeyForEvent(ev), 'gcal_primary');
});

test('providerKeyForError: passes provider strings through unchanged', () => {
  assert.equal(providerKeyForError({ provider: 'microsoft', message: 'x' }), 'microsoft');
  assert.equal(providerKeyForError({ provider: 'ics:Outlook', message: 'x' }), 'ics:Outlook');
  assert.equal(providerKeyForError({ provider: 'caldav:Home', message: 'x' }), 'caldav:Home');
  assert.equal(providerKeyForError({ provider: 'gcal_primary', message: 'x' }), 'gcal_primary');
});

// ── toWidgetEvent ───────────────────────────────────────────────

test('toWidgetEvent: maps fields, resolves calendar name, flags importance', () => {
  const ev = makeEvent({
    id: 'ics-f1-uid-2026-09-15T09:00:00.000Z',
    title: 'Standup',
    start: '2026-09-15T09:00:00.000Z',
    end: '2026-09-15T09:30:00.000Z',
    calId: 'f1',
    source: 'Outlook',
    color: '#9333ea',
    location: 'Room &amp; 1',
    description: '<p>Daily sync</p>',
    originalUrl: 'https://outlook.office.com/owa/x',
  });
  const out = toWidgetEvent(ev, {
    importantIds: new Set(['ics-f1-uid-2026-09-15T09:00:00.000Z']),
    calendarNames: { f1: 'Work' },
  });
  assert.deepEqual(out, {
    id: 'ics-f1-uid-2026-09-15T09:00:00.000Z',
    title: 'Standup',
    start: '2026-09-15T09:00:00.000Z',
    end: '2026-09-15T09:30:00.000Z',
    allDay: false,
    calId: 'f1',
    calendar: 'Work',
    color: '#9333ea',
    location: 'Room & 1',
    notes: 'Daily sync',
    meetingUrl: null,
    url: 'https://outlook.office.com/owa/x',
    important: true,
  });
});

test('toWidgetEvent: falls back to source when calendar name is unknown', () => {
  const ev = makeEvent({ calId: 'f9', source: 'Some Feed' });
  const out = toWidgetEvent(ev, { importantIds: new Set(), calendarNames: {} });
  assert.equal(out.calendar, 'Some Feed');
});

test('toWidgetEvent: important is false when the id is not in importantIds', () => {
  const ev = makeEvent({ id: 'ics-f1-a' });
  const out = toWidgetEvent(ev, { importantIds: new Set(['other-id']), calendarNames: {} });
  assert.equal(out.important, false);
});

test('toWidgetEvent: accepts a plain array for importantIds', () => {
  const ev = makeEvent({ id: 'ics-f1-a' });
  const out = toWidgetEvent(ev, { importantIds: ['ics-f1-a'], calendarNames: {} });
  assert.equal(out.important, true);
});

test('toWidgetEvent: url is null when originalUrl is absent', () => {
  const ev = makeEvent({ originalUrl: null });
  const out = toWidgetEvent(ev, { importantIds: [], calendarNames: {} });
  assert.equal(out.url, null);
});

test('toWidgetEvent: surfaces a detected meeting URL from the description', () => {
  const ev = makeEvent({ description: 'Join: https://meet.google.com/abc-defg-hij' });
  const out = toWidgetEvent(ev, { importantIds: [], calendarNames: {} });
  assert.equal(out.meetingUrl, 'https://meet.google.com/abc-defg-hij');
});

// ── toCachedEvent: the reduced shape that may touch disk ─────────

const FORBIDDEN_CACHE_FIELDS = ['description', 'location', 'originalUrl', 'caldavCalUrl', 'caldavEventUid'];

test('toCachedEvent: keeps only the fields a stale render needs', () => {
  const ev = makeEvent({
    location: 'Room 1',
    description: 'Private notes: https://meet.google.com/abc-defg-hij',
    originalUrl: 'https://outlook.office.com/owa/x',
    caldavCalUrl: 'https://dav.example.org/cal/',
    caldavEventUid: 'uid-123',
    caldavAccountId: 'acct-1',
  });
  const cached = toCachedEvent(ev);
  assert.deepEqual(Object.keys(cached).sort(), [
    'id', 'title', 'start', 'end', 'allDay', 'calId', 'color', 'source',
  ].sort());
});

test('toCachedEvent: carries none of the private event-body fields, even after JSON round-trip', () => {
  const ev = makeEvent({
    location: 'Room 1',
    description: 'secret',
    originalUrl: 'https://outlook.office.com/owa/x',
    caldavCalUrl: 'https://dav.example.org/cal/',
    caldavEventUid: 'uid-123',
  });
  const json = JSON.stringify(toCachedEvent(ev));
  for (const field of FORBIDDEN_CACHE_FIELDS) {
    assert.doesNotMatch(json, new RegExp(field), `"${field}" must never be serialised into the cache`);
  }
  assert.doesNotMatch(json, /secret/);
});

test('toCachedEvent: keeps the field providerKeyForEvent groups by, so a stale cache still groups per provider', () => {
  for (const ev of [
    makeEvent({ id: 'ics-f1-a', source: 'Outlook', calId: 'f1' }),
    makeEvent({ id: 'cdav-1-a', source: 'Work DAV', calId: 'cdav_1' }),
    makeEvent({ id: 'ms-1', source: 'Microsoft', calId: 'ms' }),
    makeEvent({ id: 'g-1', source: 'Google', calId: 'gcal_primary' }),
    makeEvent({ id: 'other-1', source: 'Somewhere', calId: 'x' }),
  ]) {
    assert.equal(providerKeyForEvent(toCachedEvent(ev)), providerKeyForEvent(ev), `grouping changed for ${ev.id}`);
  }
});

test('toCachedEvent: normalises end/allDay the same way the widget event does', () => {
  const cached = toCachedEvent(makeEvent({ end: undefined, allDay: undefined }));
  assert.equal(cached.end, null);
  assert.equal(cached.allDay, false);
});

test('toCachedEvent: a reduced event round-trips through toWidgetEvent without throwing', () => {
  const ev = makeEvent({
    location: 'Room 1',
    description: 'Join: https://meet.google.com/abc-defg-hij',
    originalUrl: 'https://outlook.office.com/owa/x',
  });
  const cached = JSON.parse(JSON.stringify(toCachedEvent(ev)));
  const out = toWidgetEvent(cached, { importantIds: [ev.id], calendarNames: { f1: 'Outlook' } });
  assert.equal(out.id, ev.id);
  assert.equal(out.title, ev.title);
  assert.equal(out.calendar, 'Outlook');
  assert.equal(out.location, '');
  assert.equal(out.notes, '');
  assert.equal(out.meetingUrl, null);
  assert.equal(out.url, null);
  assert.equal(out.important, true);
});

test('htmlToPlainText/findMeetingUrl: tolerate a missing field (undefined), as a reduced cached event has', () => {
  assert.equal(htmlToPlainText(undefined), '');
  assert.equal(htmlToPlainText(undefined, { maxLen: 4000 }), '');
  assert.equal(findMeetingUrl(undefined, undefined), null);
});

// ── toWidgetEvent: hostile-input text stays linear ───────────────

function timeToWidgetEvent(overrides) {
  const ev = makeEvent(overrides);
  const t0 = performance.now();
  toWidgetEvent(ev, { importantIds: new Set(), calendarNames: {} });
  return performance.now() - t0;
}

test('toWidgetEvent: a long trailing run of spaces stays under 100ms', () => {
  const text = 'a' + ' '.repeat(100000) + 'b';
  assert.ok(timeToWidgetEvent({ description: text, location: text }) < 100);
});

test('toWidgetEvent: a long run of unclosed "<" characters stays under 100ms', () => {
  const text = '<br>' + '<'.repeat(100000);
  assert.ok(timeToWidgetEvent({ description: text, location: text }) < 100);
});

test('toWidgetEvent: a repeated unclosed "<a " tag prefix stays under 100ms', () => {
  const text = '<a '.repeat(Math.ceil(200000 / 3));
  assert.ok(timeToWidgetEvent({ description: text, location: text }) < 100);
});

test('toWidgetEvent: a meeting URL followed by a long run of dots stays under 100ms', () => {
  const text = 'Join: https://acme.zoom.us/j/1?x=' + '.'.repeat(100000) + '&y=1';
  assert.ok(timeToWidgetEvent({ description: text, location: text }) < 100);
});

test('toWidgetEvent: a 200KB mixed hostile payload stays under 100ms', () => {
  const text = (
    '<div>Hi &amp; team</div><br>'
    + ' '.repeat(30000)
    + '<a href="https://acme.zoom.us/j/1?x=' + '.'.repeat(30000) + '">join</a>'
    + '<'.repeat(30000)
    + '<script>'.repeat(5000)
    + '<!--'.repeat(5000)
  );
  assert.ok(text.length > 150000);
  assert.ok(timeToWidgetEvent({ description: text, location: text }) < 100);
});

// ── htmlToPlainText: unclosed script/comment tags stay linear ───

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median of several runs, warmed up once first, to filter out one-off scheduling noise.
function medianHtmlToPlainTextTime(text, runs = 11) {
  htmlToPlainText(text);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    htmlToPlainText(text);
    times.push(performance.now() - t0);
  }
  return median(times);
}

// `prefix` carries a recognized tag (so htmlToPlainText treats input as markup); `unit` repeats fill out to `totalLen`.
function packedInto(prefix, unit, totalLen) {
  const body = unit.repeat(Math.ceil((totalLen - prefix.length) / unit.length) + 1);
  return (prefix + body).slice(0, totalLen);
}

test('htmlToPlainText: many unclosed <!-- comments packed into 20000 chars stays under 5ms', () => {
  const text = packedInto('<b>', '<!--', 20000);
  assert.equal(text.length, 20000);
  const t = medianHtmlToPlainTextTime(text);
  assert.ok(t < 5, `expected under 5ms, got ${t}ms`);
});

test('htmlToPlainText: many unclosed <script> tags packed into 20000 chars stays under 5ms', () => {
  const text = packedInto('<b>', '<script>', 20000);
  assert.equal(text.length, 20000);
  const t = medianHtmlToPlainTextTime(text);
  assert.ok(t < 5, `expected under 5ms, got ${t}ms`);
});

test('htmlToPlainText: many near-miss "</script...>" closers packed into 20000 chars stays under 5ms', () => {
  const text = packedInto('<b><script>', '</script   x', 20000);
  assert.equal(text.length, 20000);
  const t = medianHtmlToPlainTextTime(text);
  assert.ok(t < 5, `expected under 5ms, got ${t}ms`);
});

test('htmlToPlainText: hostile <script> flood timing does not blow up between 10000 and 20000 chars', () => {
  const text20000 = packedInto('<b>', '<script>', 20000);
  const text10000 = packedInto('<b>', '<script>', 10000);
  const t20000 = medianHtmlToPlainTextTime(text20000);
  const t10000 = medianHtmlToPlainTextTime(text10000);
  const ratio = t20000 / Math.max(t10000, 0.001);
  assert.ok(ratio < 4, `expected 20000/10000 timing ratio well under 4, got ${ratio} (t20000=${t20000}ms, t10000=${t10000}ms)`);
});

// ── mergeEventsWithCache ────────────────────────────────────────

const NOW = '2026-09-13T12:00:00.000Z';

test('mergeEventsWithCache: no cache, all providers succeed -> fresh, no stale', () => {
  const evA = makeEvent({ id: 'ics-f1-a', calId: 'f1', source: 'Outlook' });
  const fresh = { events: [evA], errors: [] };
  const result = mergeEventsWithCache(fresh, undefined, NOW);
  assert.deepEqual(result.events, [evA]);
  assert.deepEqual(result.stale, []);
  assert.equal(result.syncedAt, NOW);
  assert.deepEqual(result.nextEntry.providers['ics:Outlook'], { syncedAt: NOW, events: [evA] });
  assert.equal(result.nextEntry.usedAt, NOW);
});

test('mergeEventsWithCache: an erroring provider falls back to its cached events', () => {
  const cachedEv = makeEvent({ id: 'ics-f1-old', calId: 'f1', source: 'Outlook' });
  const cachedEntry = {
    usedAt: '2026-09-13T11:00:00.000Z',
    providers: {
      'ics:Outlook': { syncedAt: '2026-09-13T11:00:00.000Z', events: [cachedEv] },
    },
  };
  const freshEv = makeEvent({ id: 'g-1', calId: 'gcal_primary', source: 'Google' });
  const fresh = {
    events: [freshEv],
    errors: [{ provider: 'ics:Outlook', message: 'feed timed out' }],
  };
  const result = mergeEventsWithCache(fresh, cachedEntry, NOW);
  assert.deepEqual(new Set(result.events.map((e) => e.id)), new Set(['g-1', 'ics-f1-old']));
  assert.deepEqual(result.stale, [{ provider: 'ics:Outlook', syncedAt: '2026-09-13T11:00:00.000Z' }]);
  assert.equal(result.syncedAt, '2026-09-13T11:00:00.000Z');
  assert.deepEqual(result.nextEntry.providers['ics:Outlook'], cachedEntry.providers['ics:Outlook']);
  assert.deepEqual(result.nextEntry.providers.gcal_primary, { syncedAt: NOW, events: [freshEv] });
});

test('mergeEventsWithCache: an erroring provider with no prior cache contributes nothing and is not marked stale', () => {
  const fresh = { events: [], errors: [{ provider: 'microsoft', message: 'token expired' }] };
  const result = mergeEventsWithCache(fresh, undefined, NOW);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.stale, []);
  assert.equal(result.syncedAt, NOW);
  assert.equal(result.nextEntry.providers.microsoft, undefined);
});

test('mergeEventsWithCache: syncedAt is the oldest of several stale providers', () => {
  const cachedEntry = {
    usedAt: '2026-09-13T10:00:00.000Z',
    providers: {
      a: { syncedAt: '2026-09-13T09:00:00.000Z', events: [] },
      b: { syncedAt: '2026-09-13T07:00:00.000Z', events: [] },
    },
  };
  const fresh = { events: [], errors: [{ provider: 'a', message: 'x' }, { provider: 'b', message: 'y' }] };
  const result = mergeEventsWithCache(fresh, cachedEntry, NOW);
  assert.equal(result.syncedAt, '2026-09-13T07:00:00.000Z');
});

test('mergeEventsWithCache: a provider that succeeds with zero events is not carried over from cache', () => {
  const cachedEv = makeEvent({ id: 'ics-f1-old', calId: 'f1', source: 'Outlook' });
  const cachedEntry = {
    usedAt: '2026-09-13T11:00:00.000Z',
    providers: { 'ics:Outlook': { syncedAt: '2026-09-13T11:00:00.000Z', events: [cachedEv] } },
  };
  // This round, ics:Outlook produced zero events and did not error at all.
  const fresh = { events: [], errors: [] };
  const result = mergeEventsWithCache(fresh, cachedEntry, NOW);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.stale, []);
  assert.equal(result.nextEntry.providers['ics:Outlook'], undefined);
});

test('mergeEventsWithCache: succeeded provider takes precedence even if also listed as an error', () => {
  const ev = makeEvent({ id: 'ics-f1-a', calId: 'f1', source: 'Outlook' });
  const fresh = { events: [ev], errors: [{ provider: 'ics:Outlook', message: 'partial' }] };
  const result = mergeEventsWithCache(fresh, undefined, NOW);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.nextEntry.providers['ics:Outlook'], { syncedAt: NOW, events: [ev] });
});

// ── pruneRanges ─────────────────────────────────────────────────

test('pruneRanges: leaves the set untouched when at or under the cap', () => {
  const ranges = {
    a: { usedAt: '2026-09-13T10:00:00.000Z', providers: {} },
    b: { usedAt: '2026-09-13T11:00:00.000Z', providers: {} },
  };
  const result = pruneRanges(ranges, 24);
  assert.deepEqual(Object.keys(result).sort(), ['a', 'b']);
});

test('pruneRanges: drops the least-recently-used ranges beyond the cap', () => {
  const ranges = {};
  for (let i = 0; i < 26; i++) {
    ranges[`r${i}`] = { usedAt: new Date(2026, 0, 1 + i).toISOString(), providers: {} };
  }
  const result = pruneRanges(ranges, 24);
  assert.equal(Object.keys(result).length, 24);
  // r0 and r1 are the two oldest by usedAt -> dropped.
  assert.equal(result.r0, undefined);
  assert.equal(result.r1, undefined);
  assert.ok(result.r25);
  assert.ok(result.r2);
});

test('pruneRanges: default cap is 24', () => {
  const ranges = {};
  for (let i = 0; i < 25; i++) {
    ranges[`r${i}`] = { usedAt: new Date(2026, 0, 1 + i).toISOString(), providers: {} };
  }
  const result = pruneRanges(ranges);
  assert.equal(Object.keys(result).length, 24);
  assert.equal(result.r0, undefined);
});
