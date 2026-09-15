process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __setRequestFn,
  discoverCalendars,
  discoverTaskLists,
  fetchCalDavTasks,
  createCalDavTask,
  updateCalDavTask,
} from '../src/caldav.js';

// ── Fixture builders — modelled on the real mailbox.org/Open-Xchange response shape from
// SPEC.md: hrefs like /caldav/tasks/<uid>.ics, PRODID:Open-Xchange, unquoted getetag. ──

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
${responses.join('\n')}
</d:multistatus>`;
}

// A PROPFIND collection response. `comps` is the list of VEVENT/VTODO component names the
// collection advertises; omit for "no supported-calendar-component-set at all".
function collectionResponse({ href, name, color, comps }) {
  const compXml = comps
    ? `<cal:supported-calendar-component-set>${comps.map((c) => `<cal:comp name="${c}"/>`).join('')}</cal:supported-calendar-component-set>`
    : '';
  return `<d:response>
  <d:href>${href}</d:href>
  <d:propstat>
    <d:prop>
      <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
      <d:displayname>${name}</d:displayname>
      ${color ? `<ical:calendar-color>${color}</ical:calendar-color>` : ''}
      ${compXml}
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function principalResponse(href) {
  return multistatus([`<d:response>
  <d:href>/</d:href>
  <d:propstat>
    <d:prop><d:current-user-principal><d:href>${href}</d:href></d:current-user-principal></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`]);
}

function homeSetResponse(principalHref, homeHref) {
  return multistatus([`<d:response>
  <d:href>${principalHref}</d:href>
  <d:propstat>
    <d:prop><cal:calendar-home-set><d:href>${homeHref}</d:href></cal:calendar-home-set></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`]);
}

// A calendar-query REPORT response entry: one VTODO/VEVENT resource, with an (unquoted, per the
// live server) getetag and raw calendar-data text.
function objectResponse({ href, etag, calendarData }) {
  const etagXml = etag != null ? `<d:getetag>${etag}</d:getetag>` : '';
  return `<d:response>
  <d:href>${href}</d:href>
  <d:propstat>
    <d:prop>${etagXml}<c:calendar-data>${calendarData}</c:calendar-data></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function reportMultistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
${responses.join('\n')}
</d:multistatus>`;
}

function vtodoIcs(uid, extraLines = []) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Open-Xchange',
    'BEGIN:VTODO', `UID:${uid}`, 'SUMMARY:Renew the parking permit', 'STATUS:NEEDS-ACTION',
    'PERCENT-COMPLETE:0', ...extraLines,
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

// A resource whose calendar-data node-ical's RRULE validation genuinely throws on — a stand-in
// for a corrupted resource on the server (OX itself never emits RRULE for VTODO, so this can only
// happen via corruption, not a normal server response, but it proves the try/catch really guards
// a thrown exception and not just an empty parse result).
function malformedVtodoIcs(uid) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Open-Xchange',
    'BEGIN:VTODO', `UID:${uid}`, 'SUMMARY:Corrupted', 'RRULE:FREQ=BOGUS;COUNT=abc',
    'END:VTODO', 'END:VCALENDAR',
  ].join('\r\n');
}

const ACCOUNT = { id: 'cdav_1', username: 'testuser', password: 'secret' };
const LIST = { id: 'cdav_1_tasks', name: 'Tasks', url: 'https://dav.example.org/caldav/tasks/' };

// ── discoverTaskLists / discoverCalendars: VTODO-vs-VEVENT filtering ──

test('discoverTaskLists: keeps only collections advertising VTODO, including one that also advertises VEVENT', async () => {
  const calls = [];
  __setRequestFn(async (config) => {
    calls.push(config);
    if (config.method === 'PROPFIND' && config.url === 'https://dav.example.org/') {
      return { status: 207, data: principalResponse('/principals/user/testuser/') };
    }
    if (config.method === 'PROPFIND' && config.url === 'https://dav.example.org/principals/user/testuser/') {
      return { status: 207, data: homeSetResponse('/principals/user/testuser/', '/caldav/') };
    }
    if (config.method === 'PROPFIND' && config.url === 'https://dav.example.org/caldav/') {
      return {
        status: 207,
        data: multistatus([
          collectionResponse({ href: '/caldav/EventsOnly/', name: 'Events', comps: ['VEVENT'] }),
          collectionResponse({ href: '/caldav/tasks/', name: 'Tasks', comps: ['VTODO'] }),
          collectionResponse({ href: '/caldav/Both/', name: 'Both', comps: ['VEVENT', 'VTODO'] }),
        ]),
      };
    }
    throw new Error(`unexpected request: ${config.method} ${config.url}`);
  });

  const lists = await discoverTaskLists('https://dav.example.org', 'testuser', 'secret', 'cdav_1');
  __setRequestFn(null);

  assert.deepEqual(
    lists.map((l) => ({ url: l.url, name: l.name })),
    [
      { url: 'https://dav.example.org/caldav/tasks/', name: 'Tasks' },
      { url: 'https://dav.example.org/caldav/Both/', name: 'Both' },
    ]
  );
  assert.ok(lists.every((l) => l.id.startsWith('cdav_1_')));
});

test('discoverCalendars: unchanged after the shared-walk refactor — VEVENT-or-unset collections kept, VTODO-only excluded', async () => {
  __setRequestFn(async (config) => {
    if (config.method === 'PROPFIND' && config.url === 'https://dav.example.org/') {
      return { status: 207, data: principalResponse('/principals/user/testuser/') };
    }
    if (config.method === 'PROPFIND' && config.url === 'https://dav.example.org/principals/user/testuser/') {
      return { status: 207, data: homeSetResponse('/principals/user/testuser/', '/caldav/') };
    }
    if (config.method === 'PROPFIND' && config.url === 'https://dav.example.org/caldav/') {
      return {
        status: 207,
        data: multistatus([
          collectionResponse({ href: '/caldav/EventsOnly/', name: 'Events', comps: ['VEVENT'] }),
          collectionResponse({ href: '/caldav/tasks/', name: 'Tasks', comps: ['VTODO'] }),
          collectionResponse({ href: '/caldav/Both/', name: 'Both', comps: ['VEVENT', 'VTODO'] }),
          collectionResponse({ href: '/caldav/NoCompSet/', name: 'Legacy' }),
        ]),
      };
    }
    throw new Error(`unexpected request: ${config.method} ${config.url}`);
  });

  const calendars = await discoverCalendars('https://dav.example.org', 'testuser', 'secret', 'cdav_1');
  __setRequestFn(null);

  assert.deepEqual(
    calendars.map((c) => c.name),
    ['Events', 'Both', 'Legacy']
  );
});

// ── fetchCalDavTasks ──

test('fetchCalDavTasks: 404 on the list returns []', async () => {
  __setRequestFn(async () => ({ status: 404, data: '' }));
  const tasks = await fetchCalDavTasks(ACCOUNT, LIST);
  __setRequestFn(null);
  assert.deepEqual(tasks, []);
});

test('fetchCalDavTasks: non-207 throws', async () => {
  __setRequestFn(async () => ({ status: 500, data: 'boom' }));
  await assert.rejects(() => fetchCalDavTasks(ACCOUNT, LIST), /500/);
  __setRequestFn(null);
});

test('fetchCalDavTasks: a malformed VTODO is skipped, siblings still parse', async () => {
  __setRequestFn(async (config) => {
    assert.equal(config.method, 'REPORT');
    assert.equal(config.url, LIST.url);
    return {
      status: 207,
      data: reportMultistatus([
        objectResponse({ href: '/caldav/tasks/good-1.ics', etag: '1111673-3-1784650673809', calendarData: vtodoIcs('good-1') }),
        objectResponse({ href: '/caldav/tasks/bad.ics', etag: '2222-1', calendarData: malformedVtodoIcs('bad') }),
        objectResponse({ href: '/caldav/tasks/good-2.ics', etag: '3333-1', calendarData: vtodoIcs('good-2') }),
      ]),
    };
  });

  const tasks = await fetchCalDavTasks(ACCOUNT, LIST);
  __setRequestFn(null);

  assert.deepEqual(tasks.map((t) => t.uid), ['good-1', 'good-2']);
  assert.equal(tasks[0].listId, LIST.id);
  assert.equal(tasks[0].listName, LIST.name);
  assert.equal(tasks[0].listUrl, LIST.url);
  assert.equal(tasks[0].accountId, ACCOUNT.id);
  // Unquoted on the wire -> unquoted on the Task, verbatim.
  assert.equal(tasks[0].etag, '1111673-3-1784650673809');
});

// ── updateCalDavTask: If-Match ──

test('updateCalDavTask: sends If-Match verbatim with an unquoted etag', async () => {
  let seenHeaders = null;
  __setRequestFn(async (config) => {
    seenHeaders = config.headers;
    return { status: 204, data: '', headers: {} };
  });

  const task = { uid: 'uid-1', etag: '1111673-3-1784650673809' };
  await updateCalDavTask(ACCOUNT, LIST, task, { title: 'Renamed', status: 'NEEDS-ACTION', percent: 0 });
  __setRequestFn(null);

  assert.equal(seenHeaders['If-Match'], '1111673-3-1784650673809');
  assert.ok(!seenHeaders['If-Match'].startsWith('"'));
});

test('updateCalDavTask: omits If-Match when etag is null (unconditional PUT)', async () => {
  let seenHeaders = null;
  __setRequestFn(async (config) => {
    seenHeaders = config.headers;
    return { status: 204, data: '', headers: {} };
  });

  const task = { uid: 'uid-2', etag: null };
  await updateCalDavTask(ACCOUNT, LIST, task, { title: 'Renamed', status: 'NEEDS-ACTION', percent: 0 });
  __setRequestFn(null);

  assert.ok(!('If-Match' in seenHeaders));
});

test('updateCalDavTask: 412 throws an error that says the task changed on the server', async () => {
  __setRequestFn(async () => ({ status: 412, data: '', headers: {} }));

  const task = { uid: 'uid-3', etag: 'stale-etag' };
  await assert.rejects(
    () => updateCalDavTask(ACCOUNT, LIST, task, { title: 'x', status: 'NEEDS-ACTION', percent: 0 }),
    /changed on the server/
  );
  __setRequestFn(null);
});

// ── createCalDavTask: sanity coverage of the third CRUD path ──

test('createCalDavTask: PUTs with If-None-Match: * and returns a Task built from the fields sent', async () => {
  let seenConfig = null;
  __setRequestFn(async (config) => {
    seenConfig = config;
    return { status: 201, data: '', headers: {} };
  });

  const task = await createCalDavTask(ACCOUNT, LIST, {
    title: 'New task', status: 'NEEDS-ACTION', percent: 0, categories: ['admin'],
  });
  __setRequestFn(null);

  assert.equal(seenConfig.method, 'PUT');
  assert.equal(seenConfig.headers['If-None-Match'], '*');
  assert.ok(seenConfig.url.startsWith(LIST.url) && seenConfig.url.endsWith('.ics'));
  assert.equal(task.title, 'New task');
  assert.deepEqual(task.categories, ['admin']);
  assert.equal(task.listId, LIST.id);
});
