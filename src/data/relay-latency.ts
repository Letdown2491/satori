// Phase 1 of adaptive per-relay timeouts: a rolling latency profile per relay, built from the queries we
// already run many times a day (no extra network - pure observation of the fetches we do anyway). NOTHING
// reads it yet; it exists so a day of normal use yields a profile that a later phase turns into per-relay
// deadline budgets - a relay we've LEARNED is slow gets more rope without slowing the fast majority. It's
// self-calibrating to the deployment: on a slow-egress host every relay profiles slow (so feeds come back
// complete); on a fast host they profile fast (so feeds stay snappy). Recorded from pool.ts on each
// SINGLE-relay query (the feed fan-out path) - multi-relay queries can't attribute timing to one relay.
//
// PERSISTED (debounced + flush-on-exit, exactly like seen-relays) so the profile survives daemon restarts.

import { join } from 'node:path';
import { jsonStore, debouncedFlush } from './json-store.ts';

const MAX_RELAYS = 500; // LRU cap so the file can't grow without bound
const ALPHA = 0.3;      // EWMA weight for a new sample (moderate smoothing over the day's queries)
const FILE = process.env.SATORI_RELAY_LATENCY_FILE || join(process.cwd(), '.data', 'relay-latency.json');

const norm = (u: string): string => u.replace(/\/+$/, '').toLowerCase();

/** Rolling per-relay stats. `ms` = EWMA of time-to-last-event (pure relay responsiveness, excluding the
 * quiet-collapse tail); `n` = samples; `trunc` = how often the query was cut off at the hard cap while the
 * relay was still delivering (= it needs a bigger budget); `at` = last-updated (ms epoch). */
interface RelayStat { ms: number; n: number; trunc: number; at: number }

const { readAll, writeAll } = jsonStore<Record<string, RelayStat>>(FILE, 'relay-latency');

const stats = new Map<string, RelayStat>(Object.entries(readAll()));
while (stats.size > MAX_RELAYS) stats.delete(stats.keys().next().value as string);

const flusher = debouncedFlush(() => {
    const out: Record<string, RelayStat> = {};
    for (const [url, s] of stats) out[url] = s;
    writeAll(out);
}, 15000);

/** Record one relay's observed time-to-last-event (ms) + whether it was truncated at the hard cap. Cheap
 * (a map update + a debounced write); side-effect only - it never changes what the query returns. */
export function recordLatency(relay: string, ms: number, truncated: boolean): void {
    const url = norm(relay);
    if (!url) return;
    const prev = stats.get(url);
    const ewma = prev ? prev.ms * (1 - ALPHA) + ms * ALPHA : ms;
    stats.delete(url); // reinsert below → most-recently-used (LRU order)
    stats.set(url, { ms: Math.round(ewma), n: (prev?.n ?? 0) + 1, trunc: (prev?.trunc ?? 0) + (truncated ? 1 : 0), at: Date.now() });
    while (stats.size > MAX_RELAYS) stats.delete(stats.keys().next().value as string);
    flusher.schedule();
}
