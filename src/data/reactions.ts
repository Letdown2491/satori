// NIP-25 reactions - like only, mirroring Satori's data/reactions.ts. A like is a
// kind:7 "+" event; unliking is a kind:5 deletion of it. Likes live on YOUR write
// relays (so your liked-state survives reloads); counts / notifying others are out
// of scope (matching Satori). Split into template-builders + a hydration query so
// both signing modes work (bunker signs here; nip07 sign-and-resubmits).

import type { UnsignedEvent } from '../nostr/types.ts';

const now = () => Math.floor(Date.now() / 1000);

/** The curated reaction palette (NIP-25 content). `+` is a plain heart (the one-click default); the
 * rest are a small, deliberately-limited set - a picker, not an engagement-maximizing keyboard. Unicode
 * only for now (custom NIP-30 emoji is a later add). No counts are ever shown (the OnlyZaps ethos). */
export const REACTIONS = ['+', '😂', '🔥', '👍', '😮', '🙏'] as const;

/** Validate a submitted reaction against the palette; anything off-list falls back to a plain heart -
 * so the content we sign/publish is always one of our known emoji, never arbitrary user input. */
export function pickReaction(raw: string | null | undefined): string {
    return raw && (REACTIONS as readonly string[]).includes(raw) ? raw : '+';
}

/** Unsigned reaction (kind:7) for a note - `emoji` is the NIP-25 content ('+' = a plain heart). */
export function likeTemplate(me: string, note: { id: string; pubkey: string }, emoji = '+'): UnsignedEvent {
    return { kind: 7, created_at: now(), pubkey: me, content: emoji, tags: [['e', note.id], ['p', note.pubkey], ['k', '1']] };
}

/** Unsigned reaction (kind:7) for an addressable event (NIP-25): `a` = the address, `p` = the author,
 * `k` = the reacted kind. Used for articles (kind:30023). `emoji` is the content ('+' = a plain heart). */
export function articleLikeTemplate(me: string, article: { address: string; pubkey: string; kind: number }, emoji = '+'): UnsignedEvent {
    return { kind: 7, created_at: now(), pubkey: me, content: emoji, tags: [['a', article.address], ['p', article.pubkey], ['k', String(article.kind)]] };
}

/** Unsigned unlike: a kind:5 deletion of your reaction event. */
export function unlikeTemplate(me: string, reactionId: string): UnsignedEvent {
    return { kind: 5, created_at: now(), pubkey: me, content: '', tags: [['e', reactionId], ['k', '7']] };
}
