// Session-aware reply-presence (mirrors src/zaps.ts over data/zap-receipts.ts). ensureReplies /
// ensureArticleReplies hydrate the best-effort cache of WHO is in a note/article's conversation;
// replyFaces (re-exported) is read at render time to show up to 3 replier avatars (follows-first).

import { fetchReplyPresence, fetchArticleReplyPresence } from './data/replies.ts';
import { listTags } from './actions.ts';
import { relaysViaTor } from './privacy.ts';
import type { Session } from './session.ts';

export { replyFaces, replierPubkeys, type ReplyFaces } from './data/replies.ts';

/** Your follow set: prefer the already-built follows route (feeds), else the kind:3 contact list
 * (profile pages call ensureLists(['follow'])). Empty set just means no follows-first ordering. */
function followSet(s: Session & { me: string }): Set<string> {
    if (s.followsRoute?.authors?.length) return new Set(s.followsRoute.authors);
    return new Set(listTags(s, 3).filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]!));
}

// The query always kicks off (filling the TTL cache); how long we WAIT before painting is bounded so
// it can't hang the feed: Tor (relays ~12s) → don't wait, faces fill next render; clearnet → a short
// deadline so faces usually make first paint. Either way the in-flight query populates the cache.
const PRESENCE_DEADLINE_MS = 800;
async function bounded(q: Promise<unknown>, full: boolean): Promise<void> {
    if (relaysViaTor()) return;     // Tor: fire-and-forget (relays ~12s; faces fill next render)
    if (full) { await q; return; }  // wait fully - for a slow, always-uncached single page (The Commons),
                                    // so faces are ready on FIRST load; the pool caps the query at ~4s anyway.
    await Promise.race([q, new Promise<void>((r) => { const t = setTimeout(r, PRESENCE_DEADLINE_MS); t.unref?.(); })]);
}

/** Hydrate reply-faces for these notes (kind:1 repliers). `full` waits for the query (The Commons). */
export async function ensureReplies(s: Session & { me: string }, noteIds: string[], full = false): Promise<void> {
    if (noteIds.length === 0) return;
    await bounded(fetchReplyPresence(s.pool, s.myRelays, noteIds, followSet(s), s.me).catch(() => { /* best-effort */ }), full);
}

/** Hydrate reply-faces for these articles (NIP-22 kind:1111 comment authors), keyed by naddr. */
export async function ensureArticleReplies(s: Session & { me: string }, naddrs: string[], full = false): Promise<void> {
    const list = naddrs.filter(Boolean);
    if (list.length === 0) return;
    await bounded(fetchArticleReplyPresence(s.pool, s.myRelays, list, followSet(s), s.me).catch(() => { /* best-effort */ }), full);
}
