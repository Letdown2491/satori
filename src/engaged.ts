// Your reply/repost state, served from the persistent engagement cache (data/
// engagement-cache.ts) as an instant set lookup. `engageTarget(ev)` is the cache key:
// a note's event id, or an article's addressable address (so NIP-22 comment replies
// and addressable reposts resolve). `ensureEngaged` just nudges the background sync.

import { cachedReplied, cachedReposted, ensureEngagementSynced } from './data/engagement-cache.ts';
import { KIND_ARTICLE, articleAddress } from './nostr/nip23.ts';
import type { NostrEvent } from './nostr/types.ts';
import type { Session } from './session.ts';

export function hasReplied(s: Session, key: string): boolean {
    return !!s.me && cachedReplied(s.me, key);
}

export function hasReposted(s: Session, key: string): boolean {
    return !!s.me && cachedReposted(s.me, key);
}

/** The engagement cache key for an event: a note's id, an article's `kind:pubkey:d`
 * address. Use it for both the render lookup and (harmlessly) the ensureEngaged nudge. */
export function engageTarget(ev: NostrEvent): string {
    return ev.kind === KIND_ARTICLE ? articleAddress(ev) : ev.id;
}

/** Ensure the engagement cache is syncing (background, idempotent). No per-note query. */
export async function ensureEngaged(s: Session & { me: string }, _keys: Array<string>): Promise<void> {
    ensureEngagementSynced(s);
}
