// Relay trust scores from "trustedrelays", read as kind:30385 relay-trust-assertion events PUBLISHED ON
// NOSTR by the provider - NOT the old centralized trustedrelays.xyz HTTP API. We query ONLY the specific
// relay being scored (a targeted `#d` filter), so the cost is O(your relays), not O(every relay on the
// network): one tiny query per relay, no pagination. The provider's whole set is ~2,600 assertions and
// growing, so bulk-fetching it to show a handful of chips was the wrong complexity class.
//
// Caching: only POSITIVE scores are cached (disk-backed, survives restarts, 24h stale-while-revalidate).
// A relay with NO cached score is re-queried on the NEXT view - so a relay that trustedrelays evaluates
// later shows up on its own, with no manual cache-clearing. PER-INSTANCE (single-user daemon, own .data/).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debouncedFlush } from './json-store.ts';
import { fetchRelayLists } from './relays.ts';
import { INDEXER_RELAYS, writeRelaysFor } from '../nostr/nip65.ts';
import { tag1 } from '../nostr/tags.ts';
import type { Pool } from './pool.ts';
import type { NostrEvent } from '../nostr/types.ts';

// The trustedrelays assertion provider (npub1457dh60mpxuwmaanurjjsmtxuk94364xf5rph08n4y67m79t7sss3tsce3).
// Override to point at a different publisher; set empty to disable on-nostr trust scoring entirely.
const PROVIDER = process.env.SATORI_TRUST_PROVIDER ?? 'ad3cdbe9fb09b8edf7b3e0e5286d66e58b58eaa64d061bbcf3a935edf8abf421';
const KIND_RELAY_ASSERTION = 30385;
// Seed relays used only if the provider's NIP-65 can't be resolved (its write relays as of build time).
const FALLBACK_RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://ditto.pub/relay'];

const FILE = process.env.SATORI_TRUST_CACHE || join(process.cwd(), '.data', 'trust.json');
const STALE_MS = 24 * 60 * 60 * 1000; // 24h → serve cached, refresh in the background (scores move slowly)
const CAP = 2000;                     // bound the positive-score cache (a single user touches few relays)

export interface TrustScore {
    score: number;          // overall 0-100
    reliability?: number;
    quality?: number;
    accessibility?: number;
    confidence?: string;    // low | medium | high
    policy?: string;        // e.g. specialized / general
}

const norm = (url: string) => url.replace(/\/+$/, '').toLowerCase(); // match the assertion `d` tag exactly
const num = (ev: NostrEvent, k: string): number | undefined => { const raw = tag1(ev, k); const v = Number(raw); return raw !== '' && Number.isFinite(v) ? v : undefined; };

interface Entry { v: TrustScore; at: number }
const cache = new Map<string, Entry>();
(function load(): void {
    try {
        const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Entry>;
        for (const [url, e] of Object.entries(raw)) if (e && e.v && typeof e.at === 'number') cache.set(url, e);
    } catch { /* no cache yet (or old format) → refetched on demand */ }
})();

const flusher = debouncedFlush(() => {
    try {
        if (cache.size > CAP) { // keep the most-recently-refreshed
            const keep = [...cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, CAP);
            cache.clear();
            for (const [k, v] of keep) cache.set(k, v);
        }
        mkdirSync(dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
    } catch (e) { console.warn('[trust] flush failed:', (e as Error)?.message ?? e); }
}, 8000);

/** An assertion → a TrustScore, or null when it isn't an `evaluated` one with a numeric score
 * (unreachable/insufficient_data → no score, the user's decision). */
function toScore(ev: NostrEvent): TrustScore | null {
    if (tag1(ev, 'status') !== 'evaluated') return null;
    const score = num(ev, 'score');
    if (score === undefined) return null;
    return {
        score,
        reliability: num(ev, 'reliability'),
        quality: num(ev, 'quality'),
        accessibility: num(ev, 'accessibility'),
        confidence: tag1(ev, 'confidence') || undefined,
        policy: tag1(ev, 'policy') || undefined,
    };
}

/** The provider's write relays (where its assertions live), resolved via NIP-65 (fetchRelayLists is itself
 * cached) with the seed list as a fallback + redundancy. */
async function providerRelays(pool: Pool): Promise<string[]> {
    const lists = await fetchRelayLists(pool, INDEXER_RELAYS, [PROVIDER]).catch(() => null);
    return [...new Set([...writeRelaysFor(lists?.get(PROVIDER) ?? null), ...FALLBACK_RELAYS])];
}

const inflight = new Map<string, Promise<TrustScore | null>>();

/** Fetch the assertion for ONE relay (`#d` filtered). Caches a positive result; a no-score result is NOT
 * cached, so it's re-queried next time (lets a later-evaluated relay surface). Deduped per url. */
function fetchOne(pool: Pool, key: string): Promise<TrustScore | null> {
    const ex = inflight.get(key);
    if (ex) return ex;
    const p = (async () => {
        try {
            const relays = await providerRelays(pool);
            const events = await pool.query(relays, { kinds: [KIND_RELAY_ASSERTION], authors: [PROVIDER], '#d': [key], limit: 4 }, { fast: true });
            let best: NostrEvent | undefined; // newest matching assertion across the provider's relays
            for (const ev of events) if (norm(tag1(ev, 'd')) === key && (!best || ev.created_at > best.created_at)) best = ev;
            const v = best ? toScore(best) : null;
            if (v) { cache.set(key, { v, at: Date.now() }); flusher.schedule(); }
            return v;
        } catch { return cache.get(key)?.v ?? null; } // network failure: serve a prior value if any
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

/** Trust assertion for a relay (evaluated relays only), or null for no score. Fresh positives come straight
 * from the disk-backed cache; a stale positive is served while it refreshes in the background; a miss (incl.
 * a relay with no score yet) is fetched on the spot, so "no score" relays re-check on every view. */
export async function fetchTrustScore(pool: Pool, url: string): Promise<TrustScore | null> {
    if (!PROVIDER) return null;
    const key = norm(url);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < STALE_MS) return hit.v; // fresh
    if (hit) { void fetchOne(pool, key); return hit.v; }     // stale → serve now, refresh in background
    return fetchOne(pool, key);                              // miss / no score → fetch (null not cached → retries)
}
