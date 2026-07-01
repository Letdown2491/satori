// Feed builders. Following = the outbox model over people you follow. Followers =
// the same machinery over people who follow *you* (discovered via kind:3 #p).
// The Commons (key 'commons') = an algorithmic relay (feeds.nostrarchives.com). All paginate
// with an `until` cursor except this, a curated single page. We rank by REPLIES over a 7-day window
// (conversation-led discovery, "network not a scoreboard"). The JSON game-bot spam that replies
// otherwise surface (chess moves etc.) is dropped by isMachineNote. (ZAPS was tried but is
// self-zap-gameable - you can zap your own note a high amount nearly free.) The relay's path encodes
// the algorithm; metrics: reactions/replies/reposts/zaps, ranges: today/7d/30d/1y/all - one-line swap.

import type { Pool } from './pool.ts';
import type { NostrEvent, RelayList } from '../nostr/types.ts';
import { INDEXER_RELAYS, MAX_AUTHORS_PER_FILTER, routeAuthorsToRelays } from '../nostr/nip65.ts';
import { HEX64 } from '../nostr/tags.ts';
import { coalesceOne } from './coalesce.ts';
import { fetchRelayLists } from './relays.ts';
import { seenRelaysFor } from './seen-relays.ts';

export interface FeedRoute {
    authors: string[];
    route: Map<string, Set<string>>;
}

const MAX_FOLLOWERS = 200; // cap follower discovery for performance
export const TRENDING_RELAY = 'wss://feeds.nostrarchives.com/notes/trending/replies/7d';
export const TRENDING_LIMIT = 50;

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function mergeNewest(lists: NostrEvent[][], limit: number): NostrEvent[] {
    const seen = new Set<string>();
    return lists.flat()
        .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
}

/** People you follow → their write relays, grouped per relay (computed once). */
export async function buildFollowsRoute(pool: Pool, me: string, myRelays: RelayList): Promise<FeedRoute> {
    let contacts = await pool.get(myRelays.write, { kinds: [3], authors: [me] }).catch(() => null);
    if (!contacts) contacts = await pool.get(INDEXER_RELAYS, { kinds: [3], authors: [me] }).catch(() => null);
    if (!contacts) return { authors: [], route: new Map() };
    const authors = contacts.tags
        .filter((t) => t[0] === 'p' && HEX64.test(t[1] || ''))
        .map((t) => t[1] as string)
        .filter((pk) => pk !== me);
    return routeFor(pool, authors);
}

/** People who follow you → their write relays. Followers are discovered by the
 * contact lists (kind:3) that tag you; approximate (only those on queried relays)
 * and capped for performance. */
export async function buildFollowersRoute(pool: Pool, me: string, myRelays: RelayList): Promise<FeedRoute> {
    const relays = [...new Set([...INDEXER_RELAYS, ...myRelays.read])];
    const events = await pool.query(relays, { kinds: [3], '#p': [me], limit: 300 }).catch(() => []);
    const seen = new Set<string>();
    const followers: string[] = [];
    for (const ev of events) {
        if (ev.pubkey === me || seen.has(ev.pubkey)) continue;
        seen.add(ev.pubkey);
        followers.push(ev.pubkey);
        if (followers.length >= MAX_FOLLOWERS) break;
    }
    return routeFor(pool, followers);
}

async function routeFor(pool: Pool, authors: string[]): Promise<FeedRoute> {
    if (authors.length === 0) return { authors, route: new Map() };
    const relayLists = await fetchRelayLists(pool, INDEXER_RELAYS, authors);
    const route = routeAuthorsToRelays(relayLists, authors, { fallbackRelays: INDEXER_RELAYS });
    console.log(`[feeds] routing ${authors.length} authors across ${route.size} relays`);
    return { authors, route };
}

/** One page of a routed feed (Following / Followers). `until` bounds it to older
 * events; `kinds` defaults to notes + polls (pass [30023] for the long-form feed). */
export async function fetchRoutedPage(pool: Pool, route: Map<string, Set<string>>, limit: number, until?: number, kinds: number[] = [1, 1068], since?: number): Promise<NostrEvent[]> {
    const queries: Promise<NostrEvent[]>[] = [];
    for (const [relay, authorSet] of route) {
        for (const authorChunk of chunk([...authorSet], MAX_AUTHORS_PER_FILTER)) {
            const filter = { kinds, authors: authorChunk, limit: limit * 2, ...(until ? { until } : {}), ...(since ? { since } : {}) };
            queries.push(pool.query([relay], filter, { fast: true }).catch((err) => { console.warn(`[feeds] query failed for ${relay}:`, err?.message ?? err); return []; }));
        }
    }
    return mergeNewest(await Promise.all(queries), limit);
}

/** One page of a SINGLE relay's timeline (the "browse a relay" feed): newest-first events of the user's
 * feed kinds, paginated by `until`. No outbox routing - it's deliberately "what THIS relay carries". */
export async function fetchRelayPage(pool: Pool, url: string, limit: number, until: number | undefined, kinds: number[]): Promise<NostrEvent[]> {
    const filter = { kinds, limit, ...(until ? { until } : {}) };
    const raw = await pool.query([url], filter, { fast: true }).catch((err) => { console.warn(`[relay-feed] query failed for ${url}:`, err?.message ?? err); return [] as NostrEvent[]; });
    return mergeNewest([raw], limit);
}

/** Trending notes from the algorithmic relay (curated single page, relay order).
 * Single external relay with no fallback - a cold/slow connection can return
 * nothing, so an empty first attempt gets one retry before we give up. */
export async function fetchTrendingPage(pool: Pool): Promise<NostrEvent[]> {
    const fetch = () => pool.query([TRENDING_RELAY], { kinds: [1, 1068], limit: TRENDING_LIMIT })
        .catch((err) => { console.warn('[beyond] failed:', err?.message ?? err); return [] as NostrEvent[]; });
    // This external feed-relay returns nothing on a COLD pooled connection (it needs a round-trip to
    // warm up), so retry a couple times with a beat between - the connection is warm by the 2nd/3rd try.
    let events: NostrEvent[] = [];
    for (let i = 0; i < 3 && events.length === 0; i++) {
        if (i) await new Promise((r) => setTimeout(r, 700));
        events = await fetch();
    }
    const seen = new Set<string>();
    return events.filter((e) => (seen.has(e.id) ? false : seen.add(e.id))); // dedupe, keep relay order
}

// A resolved event is immutable, so a hit caches hard (30 min); a MISS is cached briefly (3 min) - the
// event may land on a relay later, but without this the same unresolvable quoted note re-pays the full
// get() timeout on every feed/thread render and scroll-back (the embed-storm that dominated the logs).
const EVENT_TTL = 30 * 60_000;
const EVENT_MISS_TTL = 3 * 60_000;
const EVENT_CAP = 3000;
const eventCache = new Map<string, { ev: NostrEvent | null; at: number }>();
function rememberEvent(id: string, ev: NostrEvent | null): NostrEvent | null {
    if (eventCache.size >= EVENT_CAP) { const oldest = eventCache.keys().next().value; if (oldest) eventCache.delete(oldest); }
    eventCache.set(id, { ev, at: Date.now() });
    return ev;
}

// Coalesce concurrent fetches for the same id (two renders quoting the same note - the embed-storm case)
// onto one round-trip, matching the in-flight idiom of the other fetch caches (dm-routing, emoji-sets).
const inflightEvents = new Map<string, Promise<NostrEvent | null>>();

/** Fetch a single event by id (for embedded reply parents / quoted notes). `opts.maxWait` shortens the
 * clearnet get for best-effort callers (embeds); results are cached (immutable hit / brief miss) and
 * concurrent fetches for the same id are coalesced. */
export async function fetchEvent(pool: Pool, id: string, relayHints: string[] = [], author?: string, opts: { maxWait?: number } = {}): Promise<NostrEvent | null> {
    const hit = eventCache.get(id);
    if (hit && Date.now() - hit.at < (hit.ev ? EVENT_TTL : EVENT_MISS_TTL)) return hit.ev;
    return coalesceOne(inflightEvents, id, () => resolveEvent(pool, id, relayHints, author, opts.maxWait));
}

async function resolveEvent(pool: Pool, id: string, relayHints: string[], author: string | undefined, maxWait?: number): Promise<NostrEvent | null> {
    // Outbox model (NIP-65): the author's OWN write relays are the canonical home of their events, so
    // query those (+ any nevent relay hints) FIRST - the big indexers are a best-effort aggregator that
    // can miss. The relay list is cached per pubkey, so for a followed author this adds no round-trip.
    if (author) {
        const writes = (await fetchRelayLists(pool, INDEXER_RELAYS, [author]).catch(() => null))?.get(author)?.write ?? [];
        // ...plus relays we've empirically seen this author on (finds events on relays they don't advertise).
        const primary = [...new Set([...relayHints, ...writes, ...seenRelaysFor(author)])].filter(Boolean);
        if (primary.length) {
            const ev = await pool.get(primary, { ids: [id] }, maxWait).catch(() => null);
            if (ev) return rememberEvent(id, ev);
        }
    }
    const relays = [...new Set([...relayHints, ...INDEXER_RELAYS])].filter(Boolean);
    return rememberEvent(id, await pool.get(relays, { ids: [id] }, maxWait).catch(() => null));
}

/** Fetch many events by id (e.g. bookmarked notes), deduped. */
export async function fetchEventsByIds(pool: Pool, ids: string[], relayHints: string[] = []): Promise<NostrEvent[]> {
    if (ids.length === 0) return [];
    const relays = [...new Set([...relayHints, ...INDEXER_RELAYS])].filter(Boolean);
    const raw = await pool.query(relays, { ids }).catch(() => []);
    const seen = new Set<string>();
    return raw.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
}

/** Direct replies to a note (kind:1 referencing it), oldest first. The note's
 * own parent context is already shown inline by the Note component, so a thread
 * is just the focused note + this - one query, fast. */
export async function fetchReplies(pool: Pool, noteId: string, relayHints: string[] = []): Promise<NostrEvent[]> {
    const relays = [...new Set([...relayHints, ...INDEXER_RELAYS])];
    // NIP-10 kind:1 replies (lowercase `e` = this note) PLUS NIP-22 kind:1111 comments: by lowercase `e`
    // (direct children of this note/comment) and by uppercase `E` (the whole comment subtree rooted here -
    // catches nested comments whose immediate `e` parent is another comment). Merge + dedupe across both.
    const [direct, rooted] = await Promise.all([
        pool.query(relays, { kinds: [1, 1111], '#e': [noteId], limit: 100 }, { fast: true }).catch(() => [] as NostrEvent[]),
        pool.query(relays, { kinds: [1111], '#E': [noteId], limit: 100 }, { fast: true }).catch(() => [] as NostrEvent[]),
    ]);
    const seen = new Set<string>();
    return [...direct, ...rooted]
        .filter((e) => e.id !== noteId && (seen.has(e.id) ? false : seen.add(e.id)))
        .sort((a, b) => a.created_at - b.created_at);
}

/** A user's notes, from their own write relays. `until` pages into older notes. */
export async function fetchAuthorNotes(pool: Pool, pubkey: string, kinds: number[], limit = 30, until?: number): Promise<NostrEvent[]> {
    if (kinds.length === 0) return []; // the viewer disabled every kind for profiles - nothing to fetch
    const lists = await fetchRelayLists(pool, INDEXER_RELAYS, [pubkey]).catch(() => new Map<string, RelayList>());
    const write = lists.get(pubkey)?.write ?? [];
    const relays = write.length ? write : INDEXER_RELAYS;
    // `kinds` is the VIEWER's profile content-type prefs (notes/polls + whichever rich kinds they enabled).
    // The manifest renders each kind's card, so no per-kind branch here - just the viewer-chosen query.
    const raw = await pool.query(relays, { kinds, authors: [pubkey], limit, ...(until ? { until } : {}) }, { fast: true }).catch(() => []);
    const seen = new Set<string>();
    return raw
        .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
}
