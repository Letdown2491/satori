// Relay-list (NIP-65) fetching + publishing.

import type { Pool } from './pool.ts';
import type { Signer } from './signer.ts';
import type { RelayList, RelayEntry, UnsignedEvent, NostrEvent } from '../nostr/types.ts';
import { INDEXER_RELAYS, parseRelayList } from '../nostr/nip65.ts';

// Relay lists are public and change rarely - cache them per pubkey so threads,
// profiles, and the feed's outbox routing don't re-fetch the same kind:10002.
const relayListCache = new Map<string, RelayList>();
export function clearRelayListCache(): void { relayListCache.clear(); }

/** Fetch kind:10002 relay lists for authors, newest per author (cached). */
export async function fetchRelayLists(pool: Pool, indexerRelays: string[], authors: string[]): Promise<Map<string, RelayList>> {
    const map = new Map<string, RelayList>();
    const todo: string[] = [];
    for (const pk of authors) {
        const cached = relayListCache.get(pk);
        if (cached) map.set(pk, cached);
        else todo.push(pk);
    }
    if (todo.length === 0) return map;

    const newest = new Map<string, number>();
    const events = await pool.query(indexerRelays, { kinds: [10002], authors: todo });
    for (const ev of events) {
        if ((newest.get(ev.pubkey) ?? -1) >= ev.created_at) continue;
        newest.set(ev.pubkey, ev.created_at);
        const list = parseRelayList(ev);
        relayListCache.set(ev.pubkey, list);
        map.set(ev.pubkey, list);
    }
    return map;
}

/** Your own NIP-65 relays, falling back to the indexers if you've published none. */
export async function fetchMyRelays(pool: Pool, me: string): Promise<RelayList> {
    const lists = await fetchRelayLists(pool, INDEXER_RELAYS, [me]).catch(() => new Map<string, RelayList>());
    const mine = lists.get(me);
    return (mine && (mine.read.length || mine.write.length))
        ? mine
        : { read: [...INDEXER_RELAYS], write: [...INDEXER_RELAYS] };
}

/** The read/write split an editable [{url,read,write}] list resolves to. */
export function relayListOf(relays: RelayEntry[]): RelayList {
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
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('Failed to publish relay list to any relay');
    return next;
}

/** Sign + publish a new kind:10002 from an editable [{url,read,write}] list,
 * sent to your new write relays + indexers. Returns the new RelayList. */
export async function publishRelayList(pool: Pool, signer: Signer, me: string, relays: RelayEntry[]): Promise<RelayList> {
    const signed = await signer.signEvent(relayListTemplate(me, relays)) as NostrEvent;
    const next = relayListOf(relays);
    const targets = [...new Set([...next.write, ...INDEXER_RELAYS])];
    const results = await pool.publish(targets, signed);
    if (!results.some((r) => r.status === 'fulfilled')) {
        throw new Error('Failed to publish relay list to any relay');
    }
    return next;
}
