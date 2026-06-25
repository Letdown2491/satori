// In-memory single-user session store, keyed by an httpOnly `sid` cookie. Two
// signing modes, both keeping the key off this server:
//   'bunker' - a live NIP-46 connection; the server signs via the bunker.
//   'nip07'  - a read-only identity (the pubkey); the browser extension signs,
//              and the server only builds templates + publishes the signed result.
// Reads (feed/profile/thread/article) are identical for both modes.

import { randomBytes } from 'node:crypto';
import { Pool } from './data/pool.ts';
import { BunkerSigner } from './data/signer.ts';
import { loadPersisted, savePersisted, removePersisted, type PersistedSession } from './store.ts';
import { accessHas } from './access.ts';
import { fetchProfiles } from './data/profiles.ts';
import { INDEXER_RELAYS } from './nostr/nip65.ts';
import type { RelayList, NostrEvent } from './nostr/types.ts';
import type { Profile } from './data/profiles.ts';
import type { FeedRoute } from './data/feeds.ts';

export type SignMode = 'bunker' | 'nip07';

export interface Session {
    id: string;
    mode: SignMode;
    pool: Pool;
    signer: BunkerSigner | null; // null for nip07 (the browser holds the key)
    me: string | null;           // user pubkey (hex), set once connected / verified
    myRelays: RelayList | null;  // NIP-65 list, resolved after login
    // Bunker login is async (it may require out-of-band approval). While it runs,
    // `connecting` is the in-flight promise; `authUrl` is the approve link if the
    // bunker sent one; `error` is the failure reason if connect rejected.
    connecting: Promise<void> | null;
    authUrl: string | null;
    error: string | null;
    // Caches (cheap to recompute, but expensive in relay round-trips). The follows
    // outbox route is built once per session; profiles accrete as we render them.
    followsRoute: FeedRoute | null;
    followersRoute: FeedRoute | null;
    draftRelays: string[] | null; // resolved kind:10013 draft-relay list, cached per session (near-static)
    profiles: Map<string, Profile>;
    // NIP-02/51 list source events (kind:3 follows, 10000 mutes, 10003 bookmarks,
    // 10001 pins), loaded lazily. `has(kind)` ⇒ loaded; value may be null (none).
    lists: Map<number, NostrEvent | null>;
    // Decrypted NIP-44 PRIVATE tags per list kind (mutes/bookmarks). `has(kind)` ⇒
    // attempted; an array = readable private tags; null = present-but-unreadable (so
    // a write must NOT clobber the encrypted content). nip07 leaves it unattempted
    // (the key isn't on this server) unless a decrypt round-trip primes it.
    privateTags: Map<number, string[][] | null>;
    // NIP-25 like + reply/repost AND NIP-57 zapped state now ALL live in the persistent
    // engagement cache (data/engagement-cache.ts), synced once and read as set lookups - not
    // per-session. (Zaps used to be a per-session Map here; folded in for one source of truth.)
    // Your poll ids (cached once, for vote-notifs). In-memory per session. The read
    // high-waters (unread bell / new-notes dot) now live in a CLIENT cookie
    // (read-state.ts), not here - client-carried + stateless.
    myPollIds: string[] | null;
    // Per-request appearance media prefs (autoLoad images/videos), refreshed from the
    // cookie on each handler entry so renderers can read them off the session without
    // threading them through every call. Deterministic from the user's cookie, so a
    // concurrent overwrite is benign.
    media?: { autoLoad: boolean };
    // Per-request reaction prefs (refreshed from the cookie alongside media): whether the like
    // button shows on notes/articles, and whether reactions appear in notifications. Both OFF by default.
    reactions?: boolean;
    reactionNotifs?: boolean;
}

const sessions = new Map<string, Session>();

export function newSessionId(): string {
    return randomBytes(18).toString('base64url');
}

function makeSession(mode: SignMode, pool: Pool, signer: BunkerSigner | null, id = newSessionId()): Session {
    const s: Session = {
        id,
        mode,
        pool,
        signer,
        me: null,
        myRelays: null,
        connecting: null,
        authUrl: null,
        error: null,
        followsRoute: null,
        followersRoute: null,
        draftRelays: null,
        profiles: new Map(),
        lists: new Map(),
        privateTags: new Map(),
        myPollIds: null,
    };
    sessions.set(s.id, s);
    return s;
}

/** A bunker (NIP-46) session - the server signs via the live bunker connection. */
export function createSession(signer: BunkerSigner, pool: Pool): Session {
    return makeSession('bunker', pool, signer);
}

/** A NIP-07 session - read-only identity; the browser extension does the signing. */
export function createNip07Session(pool: Pool, me: string): Session {
    const s = makeSession('nip07', pool, null);
    s.me = me;
    return s;
}

// --- Signing capability (the seam between sign-in methods) --------------------
// There are only two families, and they're distinguished by WHERE the key lives, which is exactly
// whether this server holds a signer. Branch on these, never on `s.mode` literals, so a new
// client-side method (e.g. NIP-55 Android signer, signer: null) joins with no route changes.

/** The key is NOT on this server, so we build templates and round-trip through the sign-request seam
 * (the browser/app signs, then POSTs the result back). NIP-07 today; NIP-55 would land here too. */
export function signsOnClient(s: Session): boolean { return s.signer === null; }

/** A live signer (NIP-46 bunker) holds the key here, so we sign/encrypt/decrypt in-process. A type
 * guard, so `s.signer` narrows to non-null in the positive branch (and after a negative early return). */
export function signsOnServer(s: Session): s is Session & { signer: BunkerSigner } { return s.signer !== null; }

/** Persist a logged-in session's resumable info (so a restart resumes it). */
export function persistSession(s: Session): void {
    if (!s.me) return;
    const p: PersistedSession =
        { mode: s.mode, me: s.me, myRelays: s.myRelays };
    if (s.mode === 'bunker' && s.signer) {
        const ex = s.signer.exportSession() as { secretHex?: string; remotePubkey?: string; relays?: string[] };
        if (ex.secretHex && ex.remotePubkey && ex.relays) p.bunker = { secretHex: ex.secretHex, remotePubkey: ex.remotePubkey, relays: ex.relays };
    }
    savePersisted(s.id, p);
}

/** Rebuild a live session from a persisted one (lazy resume after a restart).
 * Bunker: recreate the signer on its transport key + re-subscribe; nip07: just
 * the pubkey. Caches (profiles/lists/routes) start empty and refill on demand. */
function resume(sid: string): Session | undefined {
    const p = loadPersisted(sid);
    if (!p) return undefined;
    if (!accessHas(p.me)) { removePersisted(sid); return undefined; } // access policy no longer allows this pubkey
    const pool = new Pool();
    let signer: BunkerSigner | null = null;
    if (p.mode === 'bunker' && p.bunker) {
        signer = new BunkerSigner(pool, p.bunker.secretHex);
        signer.resume({ secretHex: p.bunker.secretHex, remotePubkey: p.bunker.remotePubkey, relays: p.bunker.relays });
        signer.primeUserPubkey(p.me);
        if (p.myRelays) pool.setAuth((t) => signer!.signEvent(t), [...p.myRelays.write, ...p.myRelays.read]);
    }
    const s = makeSession(p.mode, pool, signer, sid);
    s.me = p.me;
    s.myRelays = p.myRelays;
    // Prime the user's own profile so the chrome avatar/name reappear after a
    // restart (caches start empty). Fire-and-forget; the avatar shows a fallback
    // circle until it lands.
    const relays = [...new Set([...INDEXER_RELAYS, ...(p.myRelays?.read ?? [])])];
    void fetchProfiles(pool, relays, [p.me]).then((m) => m.forEach((prof, k) => s.profiles.set(k, prof))).catch(() => { /* fallback circle */ });
    return s;
}

export function getSession(id: string | null): Session | undefined {
    if (!id) return undefined;
    return sessions.get(id) ?? resume(id);
}

/** Logged in once we have the user pubkey (bunker connected / nip07 verified). */
export function isLoggedIn(s: Session | undefined): s is Session & { me: string } {
    return !!s && !!s.me;
}

export function destroySession(id: string): void {
    removePersisted(id);
    const s = sessions.get(id);
    if (!s) return;
    try { s.signer?.logout(); } catch { /* best effort */ }
    try { s.pool.closeAll(); } catch { /* best effort */ }
    sessions.delete(id);
}
