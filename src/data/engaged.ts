// Your-engagement hydration: of these targets, which have you replied to and which
// have you reposted. State only - no counts (matching the reply/quote glyph fill).
//
// Notes (by event id): a reply is your kind:1 with an `e` tag; a repost is your
// kind:6, or a quote-repost (kind:1 with `q`).
// Articles (addressable, by `kind:pubkey:d` address): a reply is a NIP-22 comment -
// your kind:1111 with an `A` root tag (NIP-22, what fetchArticleComments queries); a
// repost is a generic kind:6/16 repost carrying the article's `a` tag.
//
// Up to four batched queries on your write relays (so your own engagement survives
// reloads); the address queries are skipped when no article targets are present.

import type { Pool } from './pool.ts';
import type { RelayList, NostrEvent } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { KIND_COMMENT } from '../nostr/nip22.ts';

const writeRelays = (r: RelayList | null) => (r && r.write.length ? r.write : INDEXER_RELAYS);

/** A note (id only) or an article (id + addressable `kind:pubkey:d` address). The id
 * is always the cache/render key; the address is how article engagement is queried. */
export interface EngageTarget { id: string; address?: string }

/** Of `targets`, which you've replied to / reposted (keyed by target id). A kind:1
 * carrying BOTH `e` and `q` for a note is a quote-repost (reposted, not replied). */
export async function fetchMyEngagement(
    pool: Pool, me: string, myRelays: RelayList | null, targets: EngageTarget[],
): Promise<{ replied: Set<string>; reposted: Set<string> }> {
    const replied = new Set<string>();
    const reposted = new Set<string>();
    if (targets.length === 0) return { replied, reposted };
    const relays = writeRelays(myRelays);
    const ids = targets.map((t) => t.id);
    const idSet = new Set(ids);
    const addrTargets = targets.filter((t) => t.address);
    const addresses = addrTargets.map((t) => t.address!);
    const addrToId = new Map(addrTargets.map((t) => [t.address!, t.id]));

    const queries = [
        pool.query(relays, { kinds: [1, 6], authors: [me], '#e': ids }),
        pool.query(relays, { kinds: [1], authors: [me], '#q': ids }),
    ];
    if (addresses.length) {
        queries.push(pool.query(relays, { kinds: [KIND_COMMENT], authors: [me], '#A': addresses })); // NIP-22 article replies
        queries.push(pool.query(relays, { kinds: [6, 16], authors: [me], '#a': addresses }));         // article reposts
    }
    const [byE = [], byQ = [], byAComment = [], byARepost = []] = await Promise.all(
        queries.map((q) => q.catch(() => [] as NostrEvent[])),
    );

    for (const ev of byE) {
        const quoted = new Set(ev.tags.filter((t) => t[0] === 'q' && t[1]).map((t) => t[1]!));
        for (const t of ev.tags) {
            if (t[0] !== 'e' || !t[1] || !idSet.has(t[1])) continue;
            if (ev.kind === 6) reposted.add(t[1]);          // plain repost
            else if (quoted.has(t[1])) reposted.add(t[1]);  // quote-repost that also tags `e`
            else replied.add(t[1]);                         // kind:1 reply
        }
    }
    for (const ev of byQ) for (const t of ev.tags) if (t[0] === 'q' && t[1] && idSet.has(t[1])) reposted.add(t[1]);
    for (const ev of byAComment) for (const t of ev.tags) if (t[0] === 'A' && t[1] && addrToId.has(t[1])) replied.add(addrToId.get(t[1])!);
    for (const ev of byARepost) for (const t of ev.tags) if (t[0] === 'a' && t[1] && addrToId.has(t[1])) reposted.add(addrToId.get(t[1])!);
    return { replied, reposted };
}
