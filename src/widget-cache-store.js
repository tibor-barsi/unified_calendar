import fs from 'node:fs/promises';
import path from 'node:path';
import { pruneRanges } from './widget.js';

// Hard ceiling on the serialised cache file; MAX_CACHED_RANGES bounds the range count, this bounds the bytes.
export const MAX_CACHE_BYTES = 1024 * 1024;

// True only for an explicit "1"/"true" — the disk cache is opt-in, since it puts event data on disk.
export function widgetCacheEnabled(env = process.env) {
  const raw = String(env?.UNIFIED_CALENDAR_WIDGET_CACHE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

// Drops least-recently-used ranges until the serialised cache fits `maxBytes`; a single oversized range leaves {}.
function capBySize(cache, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(cache)) <= maxBytes) return cache;
  const entries = Object.entries(cache.ranges || {})
    .sort((a, b) => (Date.parse(b[1]?.usedAt) || 0) - (Date.parse(a[1]?.usedAt) || 0));
  const kept = [];
  for (const entry of entries) {
    const candidate = { ranges: Object.fromEntries([...kept, entry]) };
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxBytes) break;
    kept.push(entry);
  }
  return { ranges: Object.fromEntries(kept) };
}

// Atomic load/save of data/widget-cache.json; use mergeRange (not load+save) for a read-modify-write.
export function createWidgetCacheStore({ dir, maxBytes = MAX_CACHE_BYTES }) {
  const file = path.join(dir, 'widget-cache.json');

  // Promise-chain mutex: queues load/save/mergeRange so they never interleave.
  let queue = Promise.resolve();
  function runExclusive(fn) {
    const result = queue.then(fn, fn);
    // Keep the queue alive even if `fn` throws.
    queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function loadRaw() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.ranges !== 'object' || data.ranges === null) {
        return { ranges: {} };
      }
      return { ranges: data.ranges };
    } catch {
      // Missing or corrupt file: start from an empty cache rather than fail.
      return { ranges: {} };
    }
  }

  // Returns what actually landed on disk, which the size cap may have trimmed.
  async function saveRaw(cache) {
    const capped = capBySize(cache, maxBytes);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.widget-cache.json.${process.pid}.${Date.now()}.tmp`);
    try {
      // No pretty-print indent: this file is machine-read only. Created 0o600 from the outset so
      // it is never briefly world-readable between write and chmod.
      await fs.writeFile(tmp, JSON.stringify(capped), { mode: 0o600 });
      // Always 0o600, including over an existing looser file: this is private state, and a file
      // left at 0o644 by an older build would otherwise stay world-readable forever.
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, file);
      return capped;
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  return {
    async load() {
      return runExclusive(loadRaw);
    },

    async save(cache) {
      return runExclusive(() => saveRaw(cache));
    },

    async mergeRange(rangeKey, entry, maxRanges = 24) {
      return runExclusive(async () => {
        const current = await loadRaw();
        const next = { ranges: pruneRanges({ ...current.ranges, [rangeKey]: entry }, maxRanges) };
        return saveRaw(next);
      });
    },
  };
}

// Same contract, no disk: what the widget routes get when the opt-in cache is off.
// The widget still works online — only the offline "stale / syncedAt" fallback is lost.
export function createNullCacheStore() {
  return {
    async load() {
      return { ranges: {} };
    },
    async save() {},
    async mergeRange() {
      return { ranges: {} };
    },
  };
}
