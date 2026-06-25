// NIP-25 reactions - like only, mirroring Satori's data/reactions.ts. A like is a
// kind:7 "+" event; unliking is a kind:5 deletion of it. Likes live on YOUR write
// relays (so your liked-state survives reloads); counts / notifying others are out
// of scope (matching Satori). Split into template-builders + a hydration query so
// both signing modes work (bunker signs here; nip07 sign-and-resubmits).

import type { UnsignedEvent } from '../nostr/types.ts';

const now = () => Math.floor(Date.now() / 1000);

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
