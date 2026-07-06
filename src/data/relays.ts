// Relay-list (NIP-65) fetching + publishing.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debouncedFlush, lruEvictByLastUsed } from './json-store.ts';
import { coalesceBatch } from './coalesce.ts';
import { anyAccepted, type Pool, type ReadOpts } from './pool.ts';
import type { Signer } from './signer.ts';
import type { RelayList, RelayEntry, UnsignedEvent, NostrEvent } from '../nostr/types.ts';
import { INDEXER_RELAYS, parseRelayList } from '../nostr/nip65.ts';
import { localFetchMissing } from '../local-relay.ts';

// Relay lists (NIP-65) are public and change rarely, yet they route nearly every read (feed outbox,
// profiles, author notes, replies). Disk-backed stale-while-revalidate: serve instantly from cache, refresh
// stale entries in the background (so a follow MIGRATING their relays is picked up within STALE_MS, not
// pinned to the old set until a restart), and persist across restarts so a cold start skips the kind:10002
// sweep. Capped + LRU so it can't grow unbounded. Same pattern as profile-cache / trust; single-user → one
// shared cache.
interface RelayCacheEntry { list: RelayList; at: number; lastUsed: number }
const FILE = process.env.SATORI_RELAY_CACHE || join(process.cwd(), '.data', 'relays.json');
const CAP = 10_000;
const STALE_MS = 12 * 60 * 60 * 1000; // 12h → serve cached, refresh in the background
const relayListCache = new Map<string, RelayCacheEntry>();

(function load(): void {
    try {
        const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, RelayCacheEntry>;
        for (const [pk, e] of Object.entries(raw)) if (e?.list) relayListCache.set(pk, e);
    } catch { /* no cache yet */ }
})();

const flusher = debouncedFlush(() => {
    try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(Object.fromEntries(relayListCache)), { mode: 0o600 }); }
    catch (e) { console.warn('[relays] cache flush failed:', (e as Error)?.message ?? e); }
}, 8000);

/** Drop the whole cache (called when you change your OWN relays - a blunt but rare invalidation). */
export function clearRelayListCache(): void { relayListCache.clear(); flusher.schedule(); }

// In-flight coalescing: concurrent first-touches of the same pubkeys (e.g. the feed route build and the
// profile hydrate both resolving the same ~225 follows on a cold start) share one kind:10002 query.
const inflight = new Map<string, Promise<void>>();

/** Fetch + cache a batch of relay lists from the indexers (one query for the whole batch). `read` carries
 * the private-relay policy: resolution passes { direct: localFetchMissing() } so kind:10002 discovery hits
 * the indexers directly in "fetch missing" mode (finding authors' EXACT write relays for a true outbox
 * fallback), and your own list passes { complete } so it reads the full set. */
async function doFetch(pool: Pool, indexerRelays: string[], pubkeys: string[], read: ReadOpts = {}): Promise<void> {
    const newest = new Map<string, number>();
    const events = await pool.query(indexerRelays, { kinds: [10002], authors: pubkeys }, read);
    for (const ev of events) {
        if ((newest.get(ev.pubkey) ?? -1) >= ev.created_at) continue;
        newest.set(ev.pubkey, ev.created_at);
        relayListCache.set(ev.pubkey, { list: parseRelayList(ev), at: Date.now(), lastUsed: Date.now() });
    }
    lruEvictByLastUsed(relayListCache, CAP);
    flusher.schedule();
}

/** Query the pubkeys not already in flight (as one batch), then await our fetch plus any concurrent
 * in-flight fetches covering them, so the cache is ready on return. */
async function ensureFetched(pool: Pool, indexerRelays: string[], pubkeys: string[], read: ReadOpts): Promise<void> {
    await coalesceBatch(inflight, pubkeys, (todo) =>
        doFetch(pool, indexerRelays, todo, read).catch((e) => { console.warn('[relays] fetch failed:', (e as Error)?.message ?? e); }));
}

/** Fetch kind:10002 relay lists for authors, newest per author. Disk-backed stale-while-revalidate:
 * cached lists return instantly (stale ones refresh in the background); only genuine misses block. `read`
 * is the private-relay policy for the discovery query (see doFetch). DEFAULT: `direct` when "fetch missing"
 * is on - so EVERY outbox resolution (read: a note/profile; write: a reply/quote relay hint) discovers the
 * author's EXACT relays from the indexers, rather than a private relay that doesn't carry kind:10002.
 * Overridden by fetchMyRelays ({complete}) and trust ({direct:true}, always on). */
export async function fetchRelayLists(pool: Pool, indexerRelays: string[], authors: string[], read: ReadOpts = { direct: localFetchMissing() }): Promise<Map<string, RelayList>> {
    const map = new Map<string, RelayList>();
    const need: string[] = [];   // not cached → must fetch before returning
    const stale: string[] = [];  // cached but past STALE_MS → serve now, refresh in the background
    const now = Date.now();
    for (const pk of authors) {
        const e = relayListCache.get(pk);
        if (e) { e.lastUsed = now; map.set(pk, e.list); if (now - e.at > STALE_MS) stale.push(pk); }
        else need.push(pk);
    }
    if (stale.length) void ensureFetched(pool, indexerRelays, stale, read); // serve-then-refresh (non-blocking)
    if (need.length) {
        await ensureFetched(pool, indexerRelays, need, read);
        for (const pk of need) { const e = relayListCache.get(pk); if (e) map.set(pk, e.list); }
    }
    return map;
}

/** Your own NIP-65 relays, falling back to the indexers if you've published none. */
export async function fetchMyRelays(pool: Pool, me: string): Promise<RelayList> {
    // Your OWN relay list: read the COMPLETE set (private relay unioned in) so a private-only-published
    // kind:10002 is seen and Only mode can't serve a partial copy that misroutes everything.
    const lists = await fetchRelayLists(pool, INDEXER_RELAYS, [me], { complete: true }).catch(() => new Map<string, RelayList>());
    const mine = lists.get(me);
    return (mine && (mine.read.length || mine.write.length))
        ? mine
        : { read: [...INDEXER_RELAYS], write: [...INDEXER_RELAYS] };
}

/** The read/write split an editable [{url,read,write}] list resolves to. */
function relayListOf(relays: RelayEntry[]): RelayList {
    return {
        read: relays.filter((r) => r.read).map((r) => r.url),
        write: relays.filter((r) => r.write).map((r) => r.url),
    };
}

/** Build the unsigned kind:10002 from an editable list (no signing/publishing). */
export function relayListTemplate(me: string, relays: RelayEntry[]): UnsignedEvent {
    const tags = relays
        .filter((r) => r.read || r.write)
        .map((r) => ((r.read && r.write) ? ['r', r.url] : ['r', r.url, r.read ? 'read' : 'write']));
    return { kind: 10002, created_at: Math.floor(Date.now() / 1000), tags, content: '', pubkey: me };
}

/** Publish a signed kind:10002 to the new write relays + indexers (nip07 path:
 * the extension already signed; we only deliver). The new RelayList is derived
 * from the signed event's `r` tags. */
export async function publishRelayListSigned(pool: Pool, signed: NostrEvent): Promise<RelayList> {
    const next = parseRelayList(signed);
    const targets = [...new Set([...next.write, ...INDEXER_RELAYS])];
    const results = await pool.publish(targets, signed);
    if (!anyAccepted(results)) throw new Error('Failed to publish relay list to any relay');
    return next;
}

/** Sign + publish a new kind:10002 from an editable [{url,read,write}] list,
 * sent to your new write relays + indexers. Returns the new RelayList. */
export async function publishRelayList(pool: Pool, signer: Signer, me: string, relays: RelayEntry[]): Promise<RelayList> {
    const signed = await signer.signEvent(relayListTemplate(me, relays)) as NostrEvent;
    const next = relayListOf(relays);
    const targets = [...new Set([...next.write, ...INDEXER_RELAYS])];
    const results = await pool.publish(targets, signed);
    if (!anyAccepted(results)) {
        throw new Error('Failed to publish relay list to any relay');
    }
    return next;
}
