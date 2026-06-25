// Shared NIP-17 DM relay routing + the two-target publish, used by BOTH signing paths
// (data/dms.ts bunker, data/dms-nip07.ts nip07). One cache here, so the DM-relay editor's
// clearDmRelaysCache invalidates the lookup whichever path is active (each path used to keep
// its OWN cache, so clearing one left the other stale). kind:10050 almost never changes, but
// this lookup runs on every DM op + the 90s dot poll, so it's memoized per pubkey (TTL +
// in-flight coalescing) - and a never-published 10050 stops re-paying GET_MAX_WAIT every cycle.
// The 10-min TTL picks up out-of-band changes; the in-app editor invalidates your entry on save.

import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { parseDmRelays, KIND_DM_RELAYS } from '../nostr/nip17.ts';
import type { NostrEvent } from '../nostr/types.ts';
import type { Session } from '../session.ts';

const DM_RELAYS_TTL_MS = 10 * 60 * 1000;
const dmRelaysCache = new Map<string, { relays: string[]; at: number }>();
const dmRelaysInflight = new Map<string, Promise<string[]>>();

/** Drop a cached DM-relay lookup (all, or one pubkey) so the next read re-fetches.
 * Called after the DM-relay editor publishes a new kind:10050. */
export function clearDmRelaysCache(pubkey?: string): void {
    if (pubkey) dmRelaysCache.delete(pubkey); else dmRelaysCache.clear();
}

/** A pubkey's kind:10050 DM-inbox relays (or the indexers as a fallback), memoized. */
export async function dmRelaysOf(s: Session, pubkey: string): Promise<string[]> {
    const hit = dmRelaysCache.get(pubkey);
    if (hit && Date.now() - hit.at < DM_RELAYS_TTL_MS) return hit.relays;
    const inf = dmRelaysInflight.get(pubkey);
    if (inf) return inf;
    const p = (async (): Promise<string[]> => {
        const ev = await s.pool.get([...(s.myRelays?.read ?? []), ...INDEXER_RELAYS], { kinds: [KIND_DM_RELAYS], authors: [pubkey] }).catch(() => null);
        const list = ev ? parseDmRelays(ev) : [];
        const relays = list.length ? list : INDEXER_RELAYS;
        dmRelaysCache.set(pubkey, { relays, at: Date.now() }); // cache the fallback too (negatives)
        return relays;
    })();
    dmRelaysInflight.set(pubkey, p);
    try { return await p; } finally { dmRelaysInflight.delete(pubkey); }
}

/** Where to READ your own incoming wraps: your DM relays ∪ your read relays ∪ indexers.
 * Spec says senders publish to your kind-10050 DM relays, but in practice wraps also land on
 * your read relays / indexers (and some clients ignore 10050), so we query all three to find
 * everything. The 30s list cache absorbs the cost on repeat visits. */
export async function myDmReadRelays(s: Session): Promise<string[]> {
    return [...new Set([...(await dmRelaysOf(s, s.me!)), ...(s.myRelays?.read ?? []), ...INDEXER_RELAYS])];
}

/** Publish a sealed DM to both inboxes: the wrap-to-peer to the peer's DM relays, the
 * wrap-to-self to your own read relays. Shared by both signing paths so the routing stays
 * identical. Best-effort; failures are the caller's to surface. */
export async function publishWrapPair(s: Session, peer: string, toPeer: NostrEvent, toSelf: NostrEvent): Promise<void> {
    const [peerRelays, myRelays] = await Promise.all([dmRelaysOf(s, peer), myDmReadRelays(s)]);
    await Promise.all([s.pool.publish(peerRelays, toPeer), s.pool.publish(myRelays, toSelf)]);
}
