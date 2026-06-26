// NIP-25 reactions - like only, mirroring Satori's data/reactions.ts. A like is a
// kind:7 "+" event; unliking is a kind:5 deletion of it. Likes live on YOUR write
// relays (so your liked-state survives reloads); counts / notifying others are out
// of scope (matching Satori). Split into template-builders + a hydration query so
// both signing modes work (bunker signs here; nip07 sign-and-resubmits).

import type { UnsignedEvent } from '../nostr/types.ts';
import type { EmojiMap } from '../nostr/emoji30.ts';

const now = () => Math.floor(Date.now() / 1000);

/** The curated unicode reaction palette (NIP-25 content). `+` is a plain heart; the rest are a small,
 * deliberately-limited set - a picker, not an engagement-maximizing keyboard. The user's NIP-30 custom
 * emoji extend this at render time. No counts are ever shown (the OnlyZaps ethos). */
export const REACTIONS = ['+', '😂', '🔥', '👍', '😮', '🙏'] as const;

/** A resolved reaction: a unicode char / '+' (no url), OR a custom NIP-30 emoji (`emoji` = shortcode,
 * `url` = its image). The url is always resolved SERVER-SIDE from the user's own emoji set - never taken
 * from the client - so a reaction can only ever carry a url the user actually has. */
export interface Reaction { emoji: string; url?: string }

/** Resolve a submitted reaction: a palette unicode emoji, else a shortcode that's in the user's custom
 * set, else a plain heart. Off-list / unknown input can never reach the signed event. */
export function pickReaction(raw: string | null | undefined, custom: EmojiMap = {}): Reaction {
    if (raw && (REACTIONS as readonly string[]).includes(raw)) return { emoji: raw };
    // OWN string property only: an inherited prototype key (`__proto__`, `constructor`, `toString`…) would
    // otherwise read truthy on a plain-object map and yield a NON-string "url" - a crash on render + a
    // malformed kind:7. hasOwnProperty + typeof guards it even if the map isn't null-prototyped.
    if (raw && Object.prototype.hasOwnProperty.call(custom, raw) && typeof custom[raw] === 'string') return { emoji: raw, url: custom[raw] };
    return { emoji: '+' };
}

/** NIP-25 content + optional NIP-30 emoji tag for a reaction: a custom emoji is `:shortcode:` + an
 * `["emoji", shortcode, url]` tag; unicode/'+' is just the content. */
function reactionFields(r: Reaction): { content: string; emojiTag?: string[] } {
    return r.url ? { content: `:${r.emoji}:`, emojiTag: ['emoji', r.emoji, r.url] } : { content: r.emoji };
}

/** Unsigned reaction (kind:7) for a note. `r` defaults to a plain heart. */
export function likeTemplate(me: string, note: { id: string; pubkey: string }, r: Reaction = { emoji: '+' }): UnsignedEvent {
    const { content, emojiTag } = reactionFields(r);
    const tags = [['e', note.id], ['p', note.pubkey], ['k', '1'], ...(emojiTag ? [emojiTag] : [])];
    return { kind: 7, created_at: now(), pubkey: me, content, tags };
}

/** Unsigned reaction (kind:7) for an addressable event (NIP-25): `a` = the address, `p` = the author,
 * `k` = the reacted kind. Used for articles (kind:30023). */
export function articleLikeTemplate(me: string, article: { address: string; pubkey: string; kind: number }, r: Reaction = { emoji: '+' }): UnsignedEvent {
    const { content, emojiTag } = reactionFields(r);
    const tags = [['a', article.address], ['p', article.pubkey], ['k', String(article.kind)], ...(emojiTag ? [emojiTag] : [])];
    return { kind: 7, created_at: now(), pubkey: me, content, tags };
}

/** Unsigned unlike: a kind:5 deletion of your reaction event. */
export function unlikeTemplate(me: string, reactionId: string): UnsignedEvent {
    return { kind: 5, created_at: now(), pubkey: me, content: '', tags: [['e', reactionId], ['k', '7']] };
}
