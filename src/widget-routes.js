import express from 'express';
import {
  toWidgetEvent,
  toCachedEvent,
  mergeEventsWithCache,
} from './widget.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_DAYS = 100;
const MAX_CACHED_RANGES = 24;
const MAX_IMPORTANT_ID_LEN = 1000;

// Validates a star/unstar body — returns an error message, or null when the body is valid.
// Exported because the web app's POST /api/settings/important writes the same field through the
// same store function: sharing the check keeps the two routes from drifting apart.
export function importantBodyError(body) {
  const { id, important } = body && typeof body === 'object' ? body : {};
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_IMPORTANT_ID_LEN) {
    return `id must be a string of 1-${MAX_IMPORTANT_ID_LEN} characters`;
  }
  if (typeof important !== 'boolean') {
    return 'important must be a boolean';
  }
  return null;
}

// Parses "YYYY-MM-DD" into a local-midnight Date; null on bad format or calendar overflow (e.g. 2026-02-30).
function parseLocalDateStrict(str) {
  const m = DATE_RE.exec(str || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// Calendar-day count between two "YYYY-MM-DD" strings, via UTC Y/M/D arithmetic (unaffected by DST).
function daysBetween(startStr, endStr) {
  const [, sy, smo, sd] = DATE_RE.exec(startStr);
  const [, ey, emo, ed] = DATE_RE.exec(endStr);
  const startUtc = Date.UTC(Number(sy), Number(smo) - 1, Number(sd));
  const endUtc = Date.UTC(Number(ey), Number(emo) - 1, Number(ed));
  return Math.round((endUtc - startUtc) / 86400000);
}

// The cache write boundary: only reduced events are ever handed to the store — the HTTP response keeps full detail.
function toCachedEntry(entry) {
  const providers = {};
  for (const [key, provider] of Object.entries(entry?.providers || {})) {
    providers[key] = {
      syncedAt: provider.syncedAt,
      events: (provider.events || []).map(toCachedEvent),
    };
  }
  return { usedAt: entry?.usedAt, providers };
}

// Registers the widget's server API on `app`; must run before session middleware (never touches req.session).
export function registerWidgetRoutes(app, deps) {
  const checkAuthorized = (req, res) => {
    if (deps.isAuthorized && !deps.isAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  app.get('/api/widget/events', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!checkAuthorized(req, res)) return;

    const { start, end } = req.query;
    const startDate = parseLocalDateStrict(typeof start === 'string' ? start : '');
    const endDate = parseLocalDateStrict(typeof end === 'string' ? end : '');
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'start and end are required, as YYYY-MM-DD dates' });
    }

    const days = daysBetween(start, end);
    if (days <= 0) return res.status(400).json({ error: 'end must be after start' });
    if (days > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `range must be at most ${MAX_RANGE_DAYS} days` });
    }

    const rangeKey = `${start}|${end}`;

    // One outer try/catch: an uncaught throw after an await here would otherwise crash the process.
    try {
      const now = deps.now();
      const nowIso = now.toISOString();
      const timeMin = startDate.toISOString();
      const timeMax = endDate.toISOString();

      // A cache read failure degrades to "no cache" rather than crashing the process.
      let cache = { ranges: {} };
      try {
        cache = await deps.cacheStore.load();
      } catch (err) {
        console.error('widget cache load failed:', err?.message || err);
      }
      const cachedEntry = cache.ranges?.[rangeKey];

      const tokensAtStart = deps.getTokens() || {};
      const tokensSnapshotJson = JSON.stringify(tokensAtStart);
      const tokens = { ...tokensAtStart };
      const sessionLike = { tokens };

      let fresh;
      try {
        fresh = await deps.getUnifiedEvents(
          sessionLike,
          timeMin,
          timeMax,
          deps.getFeeds(),
          deps.getSettings().providers,
          deps.getGoogleCalendars(),
          deps.getCaldavAccounts()
        );
      } catch (err) {
        if (!cachedEntry) {
          return res.status(502).json({ error: err?.message || 'Failed to fetch events' });
        }
        const message = err?.message || 'Failed to fetch events';
        fresh = {
          events: [],
          errors: Object.keys(cachedEntry.providers || {}).map((provider) => ({ provider, message })),
        };
      }

      if (JSON.stringify(tokens) !== tokensSnapshotJson) {
        deps.saveTokens(tokens);
      }

      const merged = mergeEventsWithCache(fresh, cachedEntry, nowIso);

      // mergeRange re-reads on-disk state itself rather than writing back a possibly-stale `cache` snapshot.
      try {
        await deps.cacheStore.mergeRange(rangeKey, toCachedEntry(merged.nextEntry), MAX_CACHED_RANGES);
      } catch (err) {
        console.error('widget cache save failed:', err?.message || err);
      }

      const calendars = deps.listCalendars(sessionLike) || [];
      const calendarNames = {};
      for (const c of calendars) calendarNames[c.id] = c.name;

      const importantIds = new Set(deps.getSettings().importantEvents || []);
      const widgetEvents = merged.events.map((ev) => toWidgetEvent(ev, { importantIds, calendarNames }));

      res.json({
        generatedAt: nowIso,
        range: { start, end },
        calendars: calendars.map((c) => ({ id: c.id, name: c.name, color: c.color })),
        events: widgetEvents,
        errors: fresh.errors || [],
        stale: merged.stale,
        syncedAt: merged.syncedAt,
      });
    } catch (err) {
      console.error('widget events handler failed:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post(
    '/api/widget/important',
    (req, res, next) => {
      // Runs before express.json() so an unauthenticated caller's body is never read.
      res.set('Cache-Control', 'no-store');
      if (!checkAuthorized(req, res)) return;
      next();
    },
    express.json({ limit: '2kb' }),
    (err, req, res, next) => {
      // A malformed body (bad JSON, or a non-object value) lands here instead of the handler below.
      if (err) return res.status(400).json({ error: 'invalid request body' });
      next();
    },
    (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { id, important } = body;
      const error = importantBodyError(body);
      if (error) return res.status(400).json({ error });

      deps.setEventImportant(id, important);
      res.json({ id, important });
    }
  );
}
