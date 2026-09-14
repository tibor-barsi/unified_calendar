// Shared builders for widget-related tests. Lives outside test/ so node's default glob never runs it as a test.

import { pruneRanges } from '../src/widget.js';

/** A minimal but realistic unified-event object, as produced by getUnifiedEvents. */
export function makeEvent(overrides = {}) {
  return {
    id: 'ics-f1-abc-2026-09-15T09:00:00.000Z',
    title: 'Standup',
    start: '2026-09-15T09:00:00.000Z',
    end: '2026-09-15T09:30:00.000Z',
    allDay: false,
    color: '#9333ea',
    calId: 'f1',
    source: 'Outlook',
    originalUrl: null,
    location: '',
    description: '',
    ...overrides,
  };
}

/** A fake, in-memory implementation of the widget-cache-store contract. */
export function makeMemoryCacheStore(initial = { ranges: {} }) {
  let cache = JSON.parse(JSON.stringify(initial));
  const saved = [];
  return {
    async load() {
      return JSON.parse(JSON.stringify(cache));
    },
    async save(next) {
      cache = JSON.parse(JSON.stringify(next));
      saved.push(cache);
    },
    async mergeRange(rangeKey, entry, maxRanges = 24) {
      cache = { ranges: pruneRanges({ ...cache.ranges, [rangeKey]: entry }, maxRanges) };
      saved.push(JSON.parse(JSON.stringify(cache)));
      return JSON.parse(JSON.stringify(cache));
    },
    // test-only inspection helpers (not part of the real cacheStore contract)
    _current: () => cache,
    _saveCalls: () => saved,
  };
}

// Builds a full fake `deps` object for registerWidgetRoutes, with sensible defaults overridable per test.
export function makeDeps(overrides = {}) {
  const state = {
    tokens: {},
    settings: { providers: {}, importantEvents: [] },
    feeds: [],
    googleCalendars: [],
    caldavAccounts: [],
    calendars: [{ id: 'f1', name: 'Outlook', color: '#9333ea' }],
    ...overrides.state,
  };

  const base = {
    getUnifiedEvents: async () => ({ events: [], errors: [] }),
    getFeeds: () => state.feeds,
    getSettings: () => state.settings,
    getGoogleCalendars: () => state.googleCalendars,
    getCaldavAccounts: () => state.caldavAccounts,
    getTokens: () => state.tokens,
    saveTokens: (tokens) => { state.tokens = tokens; },
    listCalendars: () => state.calendars,
    setEventImportant: (id, important) => {
      const list = Array.isArray(state.settings.importantEvents)
        ? state.settings.importantEvents.slice()
        : [];
      const idx = list.indexOf(id);
      if (important) { if (idx === -1) list.push(id); }
      else if (idx !== -1) list.splice(idx, 1);
      state.settings = { ...state.settings, importantEvents: list };
      return state.settings.importantEvents;
    },
    cacheStore: makeMemoryCacheStore(),
    now: () => new Date('2026-09-13T12:00:00.000Z'),
  };

  const { state: _ignored, ...rest } = overrides;
  return { ...base, ...rest, _state: state };
}
