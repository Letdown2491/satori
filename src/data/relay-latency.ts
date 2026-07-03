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
// Adaptive-budget knobs (Step 4 tunes these against real data). DEFAULT is the caller's `base` (today's fixed
// cap = also cold-start/low-confidence). We only spend MORE than base on a relay we've LEARNED is starved.
const N_MIN = 5;         // min samples before the profile is trusted enough to adapt off the default
const TRUNC_LO = 0.2;    // truncation rate below which the base cap already finishes it (quiet/EOSE)
const PROLIFIC_EV = 100; // avg events/query above which a truncating relay is a prolific TAIL (scroll recovers it), not starved
const FILE = process.env.SATORI_RELAY_LATENCY_FILE || join(process.cwd(), '.data', 'relay-latency.json');

const norm = (u: string): string => u.replace(/\/+$/, '').toLowerCase();

/** Rolling per-relay stats. `ms` = EWMA of time-to-last-event (pure relay responsiveness, excluding the
 * quiet-collapse tail); `ev` = EWMA of events delivered per query; `n` = samples; `trunc` = how often the
 * query was cut off at the hard cap while the relay was still delivering; `at` = last-updated (ms epoch).
 * `ev` disambiguates the two truncation modes that `ms` alone conflates (both pin near the cap): a truncation
 * with ~0 `ev` is a CONNECT/DELIVERY problem (waiting longer is HIGH value - the relay barely responded), a
 * truncation with high `ev` is a PROLIFIC relay/aggregator (waiting longer just fetches more older tail that
 * scroll-pagination recovers anyway - so ceiling it). The adaptive budget keys on both. */
interface RelayStat { ms: number; ev: number; n: number; trunc: number; at: number }

const { readAll, writeAll } = jsonStore<Record<string, RelayStat>>(FILE, 'relay-latency');

const stats = new Map<string, RelayStat>(Object.entries(readAll()));
while (stats.size > MAX_RELAYS) stats.delete(stats.keys().next().value as string);

const flusher = debouncedFlush(() => {
    const out: Record<string, RelayStat> = {};
    for (const [url, s] of stats) out[url] = s;
    writeAll(out);
}, 15000);

/** Record one relay's observed time-to-last-event (ms), events delivered, and whether it was truncated at the
 * hard cap. Cheap (a map update + a debounced write); side-effect only - it never changes what the query
 * returns. */
export function recordLatency(relay: string, ms: number, truncated: boolean, events: number): void {
    const url = norm(relay);
    if (!url) return;
    const prev = stats.get(url);
    const ms2 = prev ? prev.ms * (1 - ALPHA) + ms * ALPHA : ms;
    // Seed ev from the current sample when absent (a pre-ev record, or a first sample) so the EWMA can't NaN.
    const ev2 = prev?.ev != null ? prev.ev * (1 - ALPHA) + events * ALPHA : events;
    stats.delete(url); // reinsert below → most-recently-used (LRU order)
    stats.set(url, { ms: Math.round(ms2), ev: Math.round(ev2), n: (prev?.n ?? 0) + 1, trunc: (prev?.trunc ?? 0) + (truncated ? 1 : 0), at: Date.now() });
    while (stats.size > MAX_RELAYS) stats.delete(stats.keys().next().value as string);
    flusher.schedule();
}

/** Adaptive hard-cap (ms) for a single relay, scaling from `base` toward `ceiling` by how budget-starved its
 * profile says it is. Returns `base` (today's behavior) when there's not enough evidence, when it rarely
 * truncates (finishes on its own), or when it's a PROLIFIC tail (high `ev` - waiting only fetches older events
 * that scroll-pagination recovers). Only a relay that truncates a lot while delivering LITTLE (connect/slow
 * delivery) earns extra rope, proportional to its truncation rate. Pure profile read; cheap per query. */
export function relayBudget(relay: string, base: number, ceiling: number): number {
    const s = stats.get(norm(relay));
    if (!s || s.n < N_MIN) return base;                          // not enough evidence yet → default
    const truncRate = s.trunc / s.n;
    if (truncRate < TRUNC_LO || s.ev >= PROLIFIC_EV) return base; // finishes on its own, or prolific tail
    return Math.min(ceiling, Math.round(base + truncRate * (ceiling - base)));
}
