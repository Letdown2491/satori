// NIP-25 reactions - like only, mirroring Satori's data/reactions.ts. A like is a
// kind:7 "+" event; unliking is a kind:5 deletion of it. Likes live on YOUR write
// relays (so your liked-state survives reloads); counts / notifying others are out
// of scope (matching Satori). Split into template-builders + a hydration query so
// both signing modes work (bunker signs here; nip07 sign-and-resubmits).

import type { Pool } from './pool.ts';
import type { RelayList, NostrEvent, UnsignedEvent } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';

const now = () => Math.floor(Date.now() / 1000);
const writeRelays = (r: RelayList | null) => (r && r.write.length ? r.write : INDEXER_RELAYS);

/** Which of these notes have you liked? → Map<noteId, your reaction event id>
 * (the id is needed to unlike). Only kind:7 "+"/"" (likes) count. */
export async function fetchMyLikes(pool: Pool, me: string, myRelays: RelayList | null, noteIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (noteIds.length === 0) return map;
    const events = await pool.query(writeRelays(myRelays), { kinds: [7], authors: [me], '#e': noteIds }).catch(() => [] as NostrEvent[]);
    const newest = new Map<string, number>();
    for (const ev of events) {
        if (ev.content !== '+' && ev.content !== '') continue; // like only
        const eTag = ev.tags.find((t) => t[0] === 'e' && t[1] && noteIds.includes(t[1]));
        if (!eTag) continue;
        const noteId = eTag[1]!;
        if ((newest.get(noteId) ?? -1) >= ev.created_at) continue;
        newest.set(noteId, ev.created_at);
        map.set(noteId, ev.id);
    }
    return map;
}

/** Unsigned like (kind:7 "+") for a note. */
export function likeTemplate(me: string, note: { id: string; pubkey: string }): UnsignedEvent {
    return { kind: 7, created_at: now(), pubkey: me, content: '+', tags: [['e', note.id], ['p', note.pubkey], ['k', '1']] };
}

/** Unsigned like (kind:7 "+") for an addressable event (NIP-25): `a` = the address,
 * `p` = the author, `k` = the reacted kind. Used for articles (kind:30023). */
export function articleLikeTemplate(me: string, article: { address: string; pubkey: string; kind: number }): UnsignedEvent {
    return { kind: 7, created_at: now(), pubkey: me, content: '+', tags: [['a', article.address], ['p', article.pubkey], ['k', String(article.kind)]] };
}

/** Unsigned unlike: a kind:5 deletion of your reaction event. */
export function unlikeTemplate(me: string, reactionId: string): UnsignedEvent {
    return { kind: 5, created_at: now(), pubkey: me, content: '', tags: [['e', reactionId], ['k', '7']] };
}
