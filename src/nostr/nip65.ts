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
const MAX_RELAYS = 50;
export const MAX_AUTHORS_PER_FILTER = 200;

/** Normalize a relay URL for dedup/grouping: lowercase, no trailing slash. */
export function normalizeRelayUrl(url: string): string | null {
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
        let s = u.toString();
        if (s.endsWith('/')) s = s.slice(0, -1);
        return s.toLowerCase();
    } catch {
        return null;
    }
}

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
 * bounds the relay set (highest coverage first) to MAX_RELAYS. Any author still
 * uncovered when the cap is hit is NOT dropped - they're swept onto the fallback
 * (indexer) relays so their notes still surface. Returns Map<relayUrl, Set<pubkey>>.
 */
export function routeAuthorsToRelays(
    relayLists: Map<string, RelayList>,
    authors: string[],
    { fallbackRelays = [] as string[] } = {},
): Map<string, Set<string>> {
    const fallback = fallbackRelays.map(normalizeRelayUrl).filter((u): u is string => !!u);

    const authorRelays = new Map<string, string[]>();
    for (const author of authors) {
        const write = (relayLists.get(author)?.write ?? []).slice(0, MAX_RELAYS_PER_AUTHOR);
        authorRelays.set(author, write.length > 0 ? write : fallback);
    }

    const uncovered = new Set(authors.filter((a) => (authorRelays.get(a) ?? []).length > 0));
    const chosen = new Map<string, Set<string>>();

    while (uncovered.size > 0 && chosen.size < MAX_RELAYS) {
        const coverage = new Map<string, string[]>();
        for (const author of uncovered) {
            for (const relay of authorRelays.get(author) ?? []) {
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
        for (const author of bestAuthors) uncovered.delete(author);
    }

    // Don't silently drop the tail: any author still uncovered (their write relays didn't
    // make the MAX_RELAYS cut) is queried from the fallback (indexer) relays, which mirror
    // most notes. Better an imperfect relay than the author vanishing from the feed.
    if (uncovered.size > 0 && fallback.length > 0) {
        for (const relay of fallback) {
            const set = chosen.get(relay) ?? new Set<string>();
            for (const author of uncovered) set.add(author);
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
