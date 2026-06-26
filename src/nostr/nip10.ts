// NIP-10 threading: find the note a reply is answering.

import type { NostrEvent } from './types.ts';

/** If a note is a reply, return the parent { id, relays } to embed as context -
 * the "reply"-marked e-tag, else "root", else (legacy, no markers) the last
 * e-tag. Returns null for non-replies.
 *
 * "mention"-marked e-tags and quoted events (`q` tags, or the older mention
 * convention) are references, NOT the note being replied to - excluding them
 * keeps a quote from being misread as a reply (NIP-10 / NIP-18). */
export function replyParent(note: NostrEvent): { id: string; relays: string[] } | null {
    const tags = note.tags || [];
    const quoted = new Set(tags.filter((t) => t[0] === 'q' && t[1]).map((t) => t[1]));
    const eTags = tags.filter((t) => t[0] === 'e' && t[1] && t[3] !== 'mention');
    const tag = eTags.find((t) => t[3] === 'reply')
        || eTags.find((t) => t[3] === 'root')
        || [...eTags].reverse().find((t) => !t[3] && !quoted.has(t[1])); // legacy: last unmarked, non-quote
    if (!tag || !tag[1]) return null;
    return { id: tag[1], relays: tag[2] ? [tag[2]] : [] };
}

/** The thread ROOT a reply belongs to - the "root"-marked e-tag, else the reply target. For a PRIVATE
 * reply this is the PUBLIC note the conversation hangs off (always published, so a linkable /t/), unlike
 * the immediate parent which, in a private sub-conversation, is an UNPUBLISHED private reply (a dead link). */
export function replyRoot(note: NostrEvent): { id: string; relays: string[] } | null {
    const root = (note.tags || []).find((t) => t[0] === 'e' && t[1] && t[3] === 'root');
    if (root && root[1]) return { id: root[1], relays: root[2] ? [root[2]] : [] };
    return replyParent(note); // no explicit root marker → the reply target (a direct reply's root IS its parent)
}
