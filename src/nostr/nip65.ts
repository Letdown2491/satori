// NIP-65 "outbox model": relay-list parsing + author→relay routing, plus the
// .onion→Tor-proxy URL rewriting. Pure (no pool / no DOM) and unit-tested.

import type { NostrEvent, RelayList } from './types.ts';

// Bootstrap / indexer relays: a small well-known set used ONLY to discover relay
// lists (kind:10002) and profiles (kind:0), and as a fallback when a pubkey has
// no relay list. Mirrors dark-wisp-android's RelayProber.BOOTSTRAP.
export const INDEXER_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://indexer.coracle.social',
    'wss://relay.nos.social',
    'wss://purplepag.es',
];

// Caps to bound connections and filter size. MAX_RELAYS was 25, which a large follow
// list (200+ people across many write relays) blows past - the greedy set-cover would
// stop at 25 and SILENTLY DROP every follow whose relays didn't make the cut, so their
// notes never appeared. Raised to 50 (the persistent daemon pools/reuses sockets, so the
// connection cost is mild) AND uncovered authors now fall back to the indexers rather than
// being dropped (see routeAuthorsToRelays). The persistent daemon makes this affordable.
const MAX_RELAYS_PER_AUTHOR = 3;
// 1x routing of a large follow list (~225) settles around 30 relays; 2x redundancy (below) needs more,
// so the cap has headroom to avoid truncating real coverage back onto the indexer fallback. The
// persistent daemon pools/reuses sockets (SimplePool), so the extra connections are mild.
const MAX_RELAYS = 70;
// Redundancy: route each author to up to this many of their write relays (not just one), so a note
// they published to only ONE of their relays still surfaces. A note has to be absent from BOTH chosen
// relays to vanish. Capped by the author's relay count and by MAX_RELAYS (the tail keeps 1x coverage).
const RELAYS_PER_AUTHOR_TARGET = 2;
export const MAX_AUTHORS_PER_FILTER = 200;

/** Normalize a relay URL for dedup/grouping: lowercase, no trailing slash. `assumeWss` prepends wss://
 * to a bare host (for user-entered relay sets), so settings + routing agree on one canonical form. */
export function normalizeRelayUrl(url: string, opts: { assumeWss?: boolean } = {}): string | null {
    try {
        let raw = url.trim();
        if (opts.assumeWss && raw && !/^wss?:\/\//i.test(raw)) raw = 'wss://' + raw;
        const u = new URL(raw);
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
        let s = u.toString();
        if (s.endsWith('/')) s = s.slice(0, -1);
        return s.toLowerCase();
    } catch {
        return null;
    }
}

/** The relays to PUBLISH the user's own events to: their write relays, or the indexers if they have none. */
export const writeRelaysFor = (r: RelayList | null | undefined): string[] =>
    r && r.write.length ? r.write : INDEXER_RELAYS;

/** The user's OWN relay urls: read ∪ write, deduped. No indexer fallback (callers that want the indexers
 * add them - e.g. readRelaysFor below). The relays you'd browse as a timeline, and the reader-side of the
 * outbox model when resolving a single event by id/coordinate. */
export const myRelayUrls = (r: RelayList | null | undefined): string[] =>
    [...new Set([...(r?.read ?? []), ...(r?.write ?? [])])];

/** The relays to QUERY the user's own data from: read ∪ write ∪ indexers (deduped). */
export const readRelaysFor = (r: RelayList | null | undefined): string[] =>
    [...new Set([...myRelayUrls(r), ...INDEXER_RELAYS])];

/** Parse a kind:10002 event into read/write lists (NIP-65 r-tag markers). */
export function parseRelayList(event: NostrEvent): RelayList {
    const read = new Set<string>();
    const write = new Set<string>();
    for (const tag of event.tags || []) {
        if (tag[0] !== 'r' || !tag[1]) continue;
        const url = normalizeRelayUrl(tag[1]);
        if (!url) continue;
        const marker = tag[2];
        if (marker === 'read') read.add(url);
        else if (marker === 'write') write.add(url);
        else { read.add(url); write.add(url); }
    }
    return { read: [...read], write: [...write] };
}

/**
 * Route authors to the relays they write to. Each author gets up to 3 write
 * relays; authors with none go to `fallbackRelays`. A greedy set-cover then
 * bounds the relay set (highest coverage first) to MAX_RELAYS, routing each author
 * to up to RELAYS_PER_AUTHOR_TARGET (2) of their relays for redundancy - so a note
 * they put on only one of their relays still surfaces. Any author with ZERO chosen
 * relays when the cap is hit is NOT dropped - they're swept onto the fallback
 * (indexer) relays so their notes still surface. Returns Map<relayUrl, Set<pubkey>>.
 */
export function routeAuthorsToRelays(
    relayLists: Map<string, RelayList>,
    authors: string[],
    { fallbackRelays = [] as string[] } = {},
): Map<string, Set<string>> {
    const fallback = fallbackRelays.map((u) => normalizeRelayUrl(u)).filter((u): u is string => !!u);

    const authorRelays = new Map<string, string[]>();
    for (const author of authors) {
        const write = (relayLists.get(author)?.write ?? []).slice(0, MAX_RELAYS_PER_AUTHOR);
        authorRelays.set(author, write.length > 0 ? write : fallback);
    }

    // `want` = how many MORE relays each author still wants (capped by how many they have). An author
    // stays in the cover pool until they've been routed to RELAYS_PER_AUTHOR_TARGET relays, so the greedy
    // keeps adding a 2nd relay per author after the 1st pass - not just one-and-done.
    const want = new Map<string, number>();
    for (const author of authors) {
        const n = (authorRelays.get(author) ?? []).length;
        if (n > 0) want.set(author, Math.min(RELAYS_PER_AUTHOR_TARGET, n));
    }
    const everCovered = new Set<string>(); // authors routed to >= 1 chosen relay (so they won't vanish)
    const chosen = new Map<string, Set<string>>();

    while (want.size > 0 && chosen.size < MAX_RELAYS) {
        // Coverage counts only authors who still WANT another relay, and only over relays not yet chosen.
        const coverage = new Map<string, string[]>();
        for (const [author, remaining] of want) {
            if (remaining <= 0) continue;
            for (const relay of authorRelays.get(author) ?? []) {
                if (chosen.has(relay)) continue; // this relay is already in the set
                (coverage.get(relay) ?? coverage.set(relay, []).get(relay)!).push(author);
            }
        }
        if (coverage.size === 0) break;

        let best: string | null = null;
        let bestAuthors: string[] = [];
        for (const [relay, covered] of coverage) {
            if (covered.length > bestAuthors.length) { best = relay; bestAuthors = covered; }
        }
        if (!best) break;
        chosen.set(best, new Set(bestAuthors));
        for (const author of bestAuthors) {
            everCovered.add(author);
            const remaining = want.get(author)! - 1;
            if (remaining <= 0) want.delete(author); else want.set(author, remaining);
        }
    }

    // Don't silently drop the tail: any author with ZERO chosen relays (theirs didn't make the
    // MAX_RELAYS cut) is queried from the fallback (indexer) relays, which mirror most notes.
    // Better an imperfect relay than the author vanishing from the feed.
    const orphaned = authors.filter((a) => (authorRelays.get(a)?.length ?? 0) > 0 && !everCovered.has(a));
    if (orphaned.length > 0 && fallback.length > 0) {
        for (const relay of fallback) {
            const set = chosen.get(relay) ?? new Set<string>();
            for (const author of orphaned) set.add(author);
            chosen.set(relay, set);
        }
    }

    return chosen;
}

// --- Relay URL mapping -----------------------------------------------------
// In the browser SPA, .onion relays are tunnelled through a same-origin Tor proxy
// (a browser can't open .onion WebSockets). This server port routes them at the
// WebSocket layer instead - `data/ws-tor.ts` adds a SOCKS5 agent for .onion hosts
// when TOR_SOCKS is set - so URLs pass through unchanged here (identity). With no
// Tor configured, onion relays simply fail to connect, which SimplePool tolerates.

export function toPoolUrl(url: string): string {
    return url;
}

export function fromPoolUrl(url: string): string {
    const i = url.indexOf('/tor?target=');
    if (i === -1) return url;
    try { return decodeURIComponent(url.slice(i + '/tor?target='.length)); } catch { return url; }
}

export const toPoolUrls = (urls: string[]): string[] => urls.map(toPoolUrl);
