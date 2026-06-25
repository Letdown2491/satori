// Liked-state, now served from the persistent engagement cache (data/engagement-
// cache.ts) instead of a per-page relay query: your whole like history is synced once
// and read as an instant set lookup. `ensureLikes` just makes sure that sync has been
// kicked off (idempotent, background) - no per-note round-trip.

import { cachedLikeId, ensureEngagementSynced } from './data/engagement-cache.ts';
import type { Session } from './session.ts';

export function isLiked(s: Session, noteId: string): boolean {
    return !!s.me && cachedLikeId(s.me, noteId) !== undefined;
}

/** Ensure the engagement cache is syncing (background, idempotent). No per-note query. */
export async function ensureLikes(s: Session & { me: string }, _noteIds: string[]): Promise<void> {
    ensureEngagementSynced(s);
}
