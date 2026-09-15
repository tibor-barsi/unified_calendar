process.env.TZ = 'Europe/Ljubljana';

import test from 'node:test';
import assert from 'node:assert/strict';
import { startWidgetTestApp } from '../test-support/http-test-app.js';
import { makeDeps } from '../test-support/widget-fixtures.js';

const NOW_ISO = '2026-09-15T10:00:00.000Z';

const ACCOUNT = {
  id: 'cdav_1',
  server: 'https://dav.example.org',
  username: 'testuser',
  password: 'testpass',
  displayName: 'Test Account',
};

const LIST = {
  id: 'cdav_1_tasks',
  url: 'https://dav.example.org/caldav/tasks/',
  name: 'Tasks',
  color: null,
};

function makeTask(overrides = {}) {
  return {
    id: 'cdavtodo-uid-1',
    uid: 'uid-1',
    title: 'Renew the parking permit',
    notes: 'Connect bank feed',
    status: 'NEEDS-ACTION',
    completed: false,
    completedAt: null,
    due: null,
    dueHasTime: false,
    start: null,
    priority: 0,
    percent: 0,
    categories: ['admin'],
    listId: LIST.id,
    listName: LIST.name,
    listUrl: LIST.url,
    accountId: ACCOUNT.id,
    etag: '1111673-3-1784650673809',
    ...overrides,
  };
}

// Builds a deps object with one CalDAV account and, by default, one task list holding no tasks —
// override discoverTaskLists/fetchCalDavTasks/createCalDavTask/updateCalDavTask per test.
function makeTasksDeps(overrides = {}) {
  const deps = makeDeps({
    state: { caldavAccounts: [ACCOUNT] },
    discoverTaskLists: async () => [LIST],
    fetchCalDavTasks: async () => [],
    createCalDavTask: async () => { throw new Error('createCalDavTask not stubbed for this test'); },
    updateCalDavTask: async () => { throw new Error('updateCalDavTask not stubbed for this test'); },
    ...overrides,
  });
  deps.now = () => new Date(NOW_ISO);
  return deps;
}

async function getJson(baseUrl, pathAndQuery) {
  const res = await fetch(`${baseUrl}${pathAndQuery}`);
  const body = await res.json();
  return { res, body };
}

async function postJson(baseUrl, pathAndQuery, payload) {
  const res = await fetch(`${baseUrl}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { res, body };
}

// ── GET /api/widget/tasks: response shape ──────────────────────

test('GET /api/widget/tasks: full response shape, field by field', async () => {
  const task = makeTask();
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks, [task]);
    assert.deepEqual(body.lists, [{ id: LIST.id, name: LIST.name, accountId: ACCOUNT.id, url: LIST.url }]);
    assert.equal(body.syncedAt, NOW_ISO);
    assert.deepEqual(body.errors, []);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: no CalDAV account configured -> empty response, 200', async () => {
  const deps = makeTasksDeps({ state: { caldavAccounts: [] } });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body, { tasks: [], lists: [], syncedAt: NOW_ISO, errors: [] });
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: a failing list lands in errors while a healthy list still returns its tasks', async () => {
  const listOk = { id: 'cdav_1_ok', url: 'https://dav.example.org/ok/', name: 'OK', color: null };
  const listBad = { id: 'cdav_1_bad', url: 'https://dav.example.org/bad/', name: 'Bad', color: null };
  const okTask = makeTask({ id: 'cdavtodo-ok', uid: 'ok', listId: listOk.id, listUrl: listOk.url });

  const deps = makeTasksDeps({
    discoverTaskLists: async () => [listOk, listBad],
    fetchCalDavTasks: async (account, list) => {
      if (list.id === listBad.id) throw new Error('CalDAV REPORT returned 500');
      return [okTask];
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks, [okTask]);
    assert.equal(body.lists.length, 2);
    assert.deepEqual(body.errors, [{ listId: listBad.id, message: 'CalDAV REPORT returned 500' }]);
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: a failing account discovery lands in errors, keyed by accountId', async () => {
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { throw new Error('CalDAV discovery failed: bad credentials'); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 200);
    assert.deepEqual(body.tasks, []);
    assert.deepEqual(body.lists, []);
    assert.deepEqual(body.errors, [{ listId: ACCOUNT.id, message: 'CalDAV discovery failed: bad credentials' }]);
  } finally {
    await app.close();
  }
});

// ── GET /api/widget/tasks: discovery cache ──────────────────────

test('GET /api/widget/tasks: discovery is cached within the TTL and re-runs once the TTL has elapsed', async () => {
  let discoverCalls = 0;
  let currentNow = new Date(NOW_ISO);
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { discoverCalls += 1; return [LIST]; },
  });
  deps.now = () => currentNow;

  const app = await startWidgetTestApp(deps);
  try {
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(discoverCalls, 1, 'first request discovers');

    currentNow = new Date(currentNow.getTime() + 59 * 60 * 1000); // +59min, still inside the 1h TTL
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(discoverCalls, 1, 'second request within the TTL reuses the cached discovery');

    currentNow = new Date(currentNow.getTime() + 2 * 60 * 1000); // total +61min, past the TTL
    await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(discoverCalls, 2, 'a request past the TTL re-discovers');
  } finally {
    await app.close();
  }
});

test('GET /api/widget/tasks: a failed discovery is never cached as success — the next request retries it', async () => {
  let discoverCalls = 0;
  const deps = makeTasksDeps({
    discoverTaskLists: async () => {
      discoverCalls += 1;
      if (discoverCalls === 1) throw new Error('temporary DNS failure');
      return [LIST];
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const first = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.deepEqual(first.body.errors, [{ listId: ACCOUNT.id, message: 'temporary DNS failure' }]);

    const second = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.deepEqual(second.body.lists, [{ id: LIST.id, name: LIST.name, accountId: ACCOUNT.id, url: LIST.url }]);
    assert.equal(discoverCalls, 2, 'the failed first discovery was not cached, so the second request tried again');
  } finally {
    await app.close();
  }
});

// ── GET /api/widget/tasks: auth ──────────────────────

test('GET /api/widget/tasks: 401 when isAuthorized returns false', async () => {
  const deps = makeTasksDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await getJson(app.baseUrl, '/api/widget/tasks');
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

// ── POST /api/widget/tasks: add ──────────────────────

test('POST /api/widget/tasks: happy path, defaults to the first discovered list, 201 with the created Task', async () => {
  let captured = null;
  const created = makeTask({ id: 'cdavtodo-new', uid: 'new', title: 'buy milk' });
  const deps = makeTasksDeps({
    createCalDavTask: async (account, list, fields) => {
      captured = { account, list, fields };
      return created;
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk' });
    assert.equal(res.status, 201);
    assert.deepEqual(body, { task: created });
    assert.equal(captured.account.id, ACCOUNT.id);
    assert.equal(captured.list.id, LIST.id);
    assert.equal(captured.fields.title, 'buy milk');
    assert.equal(captured.fields.status, 'NEEDS-ACTION');
    assert.equal(captured.fields.percent, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: quick-add grammar (category/priority/due) is parsed into the created fields', async () => {
  let captured = null;
  const deps = makeTasksDeps({
    createCalDavTask: async (account, list, fields) => {
      captured = fields;
      return makeTask();
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'call the bank @admin due:tomorrow !1' });
    assert.equal(res.status, 201);
    assert.equal(captured.title, 'call the bank');
    assert.deepEqual(captured.categories, ['admin']);
    assert.equal(captured.priority, 1);
    assert.equal(captured.due, '2026-09-16');
    assert.equal(captured.dueHasTime, false);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: an explicit listId routes the create call to that list', async () => {
  const listB = { id: 'cdav_1_B', url: 'https://dav.example.org/b/', name: 'B', color: null };
  let captured = null;
  const deps = makeTasksDeps({
    discoverTaskLists: async () => [LIST, listB],
    createCalDavTask: async (account, list, fields) => { captured = { list, fields }; return makeTask(); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'a task', listId: listB.id });
    assert.equal(res.status, 201);
    assert.equal(captured.list.id, listB.id);
  } finally {
    await app.close();
  }
});

for (const [label, text] of [
  ['empty', ''],
  ['whitespace-only', '   '],
  ['over-length', 'x'.repeat(501)],
]) {
  test(`POST /api/widget/tasks: ${label} text gives 400`, async () => {
    const deps = makeTasksDeps();
    const app = await startWidgetTestApp(deps);
    try {
      const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text });
      assert.equal(res.status, 400);
      assert.equal(typeof body.error, 'string');
    } finally {
      await app.close();
    }
  });
}

test('POST /api/widget/tasks: an unknown listId gives 404 (this route\'s chosen status for "no such list")', async () => {
  const deps = makeTasksDeps();
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk', listId: 'nope' });
    assert.equal(res.status, 404);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: an unknown listId forces one rediscovery before giving up', async () => {
  let discoverCalls = 0;
  const deps = makeTasksDeps({
    discoverTaskLists: async () => { discoverCalls += 1; return [LIST]; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk', listId: 'nope' });
    assert.equal(res.status, 404);
    assert.equal(discoverCalls, 2, 'the cached list and one forced refresh were both tried');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: no task list configured yet gives 400', async () => {
  const deps = makeTasksDeps({ discoverTaskLists: async () => [] });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk' });
    assert.equal(res.status, 400);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks: 401 when isAuthorized returns false', async () => {
  const deps = makeTasksDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks', { text: 'buy milk' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

// ── POST /api/widget/tasks/complete ──────────────────────

test('POST /api/widget/tasks/complete: marking a task complete', async () => {
  const task = makeTask({ status: 'NEEDS-ACTION', completed: false });
  const updated = makeTask({ status: 'COMPLETED', completed: true, completedAt: NOW_ISO, percent: 100 });
  let capturedFields = null;
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async (account, list, taskArg, fields) => { capturedFields = fields; return updated; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: true });
    assert.equal(res.status, 200);
    assert.deepEqual(body, { task: updated });
    assert.equal(capturedFields.status, 'COMPLETED');
    assert.equal(capturedFields.percent, 100);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: marking a task incomplete', async () => {
  const task = makeTask({ status: 'COMPLETED', completed: true, completedAt: NOW_ISO, percent: 100 });
  const updated = makeTask({ status: 'NEEDS-ACTION', completed: false, completedAt: null, percent: 0 });
  let capturedFields = null;
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async (account, list, taskArg, fields) => { capturedFields = fields; return updated; },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: false });
    assert.equal(res.status, 200);
    assert.deepEqual(body, { task: updated });
    assert.equal(capturedFields.status, 'NEEDS-ACTION');
    assert.equal(capturedFields.percent, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: a 412 from updateCalDavTask ("changed on the server") maps to HTTP 409', async () => {
  const task = makeTask();
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async () => {
      throw new Error('CalDAV PUT failed: task was changed on the server since it was last fetched (412 Precondition Failed)');
    },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: true });
    assert.equal(res.status, 409);
    assert.match(body.error, /changed on the server/);
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: an unknown task id gives 404', async () => {
  const deps = makeTasksDeps({ fetchCalDavTasks: async () => [] });
  const app = await startWidgetTestApp(deps);
  try {
    const { res, body } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: 'cdavtodo-ghost', completed: true });
    assert.equal(res.status, 404);
    assert.equal(typeof body.error, 'string');
  } finally {
    await app.close();
  }
});

test('POST /api/widget/tasks/complete: a non-CalDAV update failure maps to 502', async () => {
  const task = makeTask();
  const deps = makeTasksDeps({
    fetchCalDavTasks: async () => [task],
    updateCalDavTask: async () => { throw new Error('CalDAV PUT failed: 500'); },
  });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: task.id, completed: true });
    assert.equal(res.status, 502);
  } finally {
    await app.close();
  }
});

for (const [label, body] of [
  ['missing id', { completed: true }],
  ['non-string id', { id: 42, completed: true }],
  ['missing completed', { id: 'cdavtodo-uid-1' }],
  ['non-boolean completed', { id: 'cdavtodo-uid-1', completed: 'yes' }],
]) {
  test(`POST /api/widget/tasks/complete: ${label} gives 400`, async () => {
    const deps = makeTasksDeps();
    const app = await startWidgetTestApp(deps);
    try {
      const { res, body: respBody } = await postJson(app.baseUrl, '/api/widget/tasks/complete', body);
      assert.equal(res.status, 400);
      assert.equal(typeof respBody.error, 'string');
    } finally {
      await app.close();
    }
  });
}

test('POST /api/widget/tasks/complete: 401 when isAuthorized returns false', async () => {
  const deps = makeTasksDeps({ isAuthorized: () => false });
  const app = await startWidgetTestApp(deps);
  try {
    const { res } = await postJson(app.baseUrl, '/api/widget/tasks/complete', { id: 'x', completed: true });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});
