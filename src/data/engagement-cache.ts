// Your-engagement cache. Likes / reposts / replies / quotes are all events authored
// by YOU, so your whole engagement history is one bounded, queryable thing - fetched
// once (windowed), kept in sets, and synced incrementally. Feed renders then become
// pure set lookups: zero relay round-trips for engagement on the hot path, correct &
// filled on first paint. Disk-backed; single-user daemon → keyed by pubkey anyway.
// (Zaps are NOT here - a zap receipt is authored by the LNURL server, not you - they
// stay on their own targeted query.)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { naddrEncode } from 'nostr-tools/nip19';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';
import { parseZapReceipt } from './notifications.ts';
import type { Pool } from './pool.ts';
import type { RelayList, NostrEvent } from '../nostr/types.ts';
import type { Session } from '../session.ts';

/** An addressable reaction's `a`-tag (`kind:pubkey:identifier`) → the canonical naddr we key
 * article like-state by (relays:[], matching render's naddrFor). Article kinds only; else null. */
function addrToNaddr(a: string): string | null {
    const i1 = a.indexOf(':'), i2 = a.indexOf(':', i1 + 1);
    if (i1 < 0 || i2 < 0) return null;
    const kind = Number(a.slice(0, i1));
    if (kind !== KIND_ARTICLE) return null;
    const pubkey = a.slice(i1 + 1, i2), identifier = a.slice(i2 + 1);
    try { return naddrEncode({ kind, pubkey, identifier, relays: [] }); } catch { return null; }
}

// These sets grow only with YOUR OWN engagement (slow, single-user) and are intentionally not
// capped: they back zero-round-trip like/repost/reply button state, so evicting old ids would
// make older notes render wrong. Bounded in practice by your activity, not by external input.
interface UE {
    liked: Map<string, string>;  // noteId → your kind:7 event id (needed to unlike)
    reposted: Set<string>;       // note ids + article addresses (kind:6/16 e/a, kind:1 q)
    replied: Set<string>;        // note ids + article addresses (kind:1 e, kind:1111 A)
    zapped: Set<string>;         // note ids + article naddrs you zapped (kind:9735 #P=you → e/a target)
    lastSync: number;            // ms; 0 = never synced
    zapSync: number;             // ms of last ZAP backfill; 0 = never (zaps were added after likes/reposts,
                                 // so they need their OWN full-window backfill, independent of lastSync)
    syncing: boolean;
}

const FILE = process.env.SATORI_ENGAGEMENT_CACHE || join(process.cwd(), '.data', 'engagement.json');
const WINDOW_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months for the initial (cold) sync
const STALE_MS = 5 * 60 * 1000;                 // re-sync (incremental) at most this often
const LIMIT = 2000;                             // cap per query (covers recent engagement)
const writeRelays = (r: RelayList | null) => (r && r.write.length ? r.write : INDEXER_RELAYS);

const users = new Map<string, UE>();
let synced = 0, lookups = 0; // lightweight instrumentation

(function load(): void {
    try {
        const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, { liked: [string, string][]; reposted: string[]; replied: string[]; zapped?: string[]; lastSync: number; zapSync?: number }>;
        for (const [pk, u] of Object.entries(raw)) {
            users.set(pk, { liked: new Map(u.liked), reposted: new Set(u.reposted), replied: new Set(u.replied), zapped: new Set(u.zapped ?? []), lastSync: u.lastSync || 0, zapSync: u.zapSync || 0, syncing: false });
        }
    } catch { /* no cache yet */ }
})();

function ue(me: string): UE {
    let u = users.get(me);
    if (!u) { u = { liked: new Map(), reposted: new Set(), replied: new Set(), zapped: new Set(), lastSync: 0, zapSync: 0, syncing: false }; users.set(me, u); }
    return u;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        try {
            const out: Record<string, unknown> = {};
            for (const [pk, u] of users) out[pk] = { liked: [...u.liked], reposted: [...u.reposted], replied: [...u.replied], zapped: [...u.zapped], lastSync: u.lastSync, zapSync: u.zapSync };
            mkdirSync(dirname(FILE), { recursive: true });
            writeFileSync(FILE, JSON.stringify(out), { mode: 0o600 });
        } catch (e) { console.warn('[engagement-cache] flush failed:', (e as Error)?.message ?? e); }
    }, 8000);
}

// --- reads (the hot path) --------------------------------------------------

/** Your kind:7 reaction id for a note (→ liked, and needed to unlike), or undefined. */
export function cachedLikeId(me: string, noteId: string): string | undefined { lookups++; return ue(me).liked.get(noteId); }
export function cachedReposted(me: string, key: string): boolean { return ue(me).reposted.has(key); }
export function cachedReplied(me: string, key: string): boolean { return ue(me).replied.has(key); }
export function cachedZapped(me: string, key: string): boolean { return ue(me).zapped.has(key); }

// --- optimistic mutations (keep the cache correct the instant you act) -----

export function setLike(me: string, noteId: string, reactionId: string): void { ue(me).liked.set(noteId, reactionId); scheduleFlush(); }
export function clearLike(me: string, noteId: string): void { ue(me).liked.delete(noteId); scheduleFlush(); }
export function addZapped(me: string, key: string): void { ue(me).zapped.add(key); scheduleFlush(); }

// --- sync ------------------------------------------------------------------

/** Idempotent: kick off a background sync if the cache is cold or stale. Never blocks
 * the render - a cold cache shows neutral engagement once, then it's instant forever. */
export function ensureEngagementSynced(s: Session & { me: string }): void {
    const u = ue(s.me);
    if (u.syncing) return;
    // Sync if stale OR if zaps were never backfilled (a fresh-but-zapless cache from before zaps
    // were tracked still needs its one full-window zap pull).
    if (u.lastSync && Date.now() - u.lastSync < STALE_MS && u.zapSync) return;
    void syncEngagement(s.pool, s.me, s.myRelays);
}

async function syncEngagement(pool: Pool, me: string, myRelays: RelayList | null): Promise<void> {
    const u = ue(me);
    if (u.syncing) return;
    u.syncing = true;
    try {
        const relays = writeRelays(myRelays);
        const since = u.lastSync ? Math.floor(u.lastSync / 1000) - 60 : Math.floor((Date.now() - WINDOW_MS) / 1000);
        // Zaps get their OWN since: a cache from before zap-tracking has lastSync set but no zaps, so
        // it must do a full-window backfill once (else `since` skips all your historical zaps).
        const zapSince = u.zapSync ? Math.floor(u.zapSync / 1000) - 60 : Math.floor((Date.now() - WINDOW_MS) / 1000);
        const [reactions, posts, zaps] = await Promise.all([
            pool.query(relays, { authors: [me], kinds: [7], since, limit: LIMIT }).catch(() => [] as NostrEvent[]),
            pool.query(relays, { authors: [me], kinds: [1, 6, 16, 1111], since, limit: LIMIT }).catch(() => [] as NostrEvent[]),
            // Zaps YOU sent: a receipt (9735) is authored by the LNURL server, not you, but carries
            // a `P` tag = the zap-request signer. `#P:[me]` is the bounded, author-keyed handle on
            // your zaps (best-effort: a receipt omitting `P` is missed - fine for a soft glyph).
            pool.query(relays, { kinds: [9735], '#P': [me], since: zapSince, limit: LIMIT }).catch(() => [] as NostrEvent[]),
        ]);
        if (!u.zapSync) console.log(`[engagement] zap backfill: ${zaps.length} receipt(s) via #P for ${me.slice(0, 8)}…`); // diagnostic: 0 ⇒ relays/LNURL don't tag receipts with P
        const newestLike = new Map<string, number>();
        for (const ev of reactions) {
            if (ev.content !== '+' && ev.content !== '') continue;
            // NIP-25: last e tag = reacted note; an `a` tag = an addressable target (an article).
            const e = [...ev.tags].reverse().find((t) => t[0] === 'e' && t[1]);
            const a = e ? null : [...ev.tags].reverse().find((t) => t[0] === 'a' && t[1]);
            const key = e ? e[1]! : a ? addrToNaddr(a[1]!) : null; // articles keyed by canonical naddr
            if (!key) continue;
            if ((newestLike.get(key) ?? -1) >= ev.created_at) continue;
            newestLike.set(key, ev.created_at);
            u.liked.set(key, ev.id);
        }
        for (const ev of posts) {
            if (ev.kind === 1) {
                const qs = ev.tags.filter((t) => t[0] === 'q' && t[1]).map((t) => t[1]!);
                for (const q of qs) u.reposted.add(q);
                for (const t of ev.tags) if (t[0] === 'e' && t[1] && !qs.includes(t[1])) u.replied.add(t[1]);
            } else if (ev.kind === 6 || ev.kind === 16) {
                for (const t of ev.tags) if ((t[0] === 'e' || t[0] === 'a') && t[1]) u.reposted.add(t[1]);
            } else if (ev.kind === 1111) {
                for (const t of ev.tags) if (t[0] === 'A' && t[1]) u.replied.add(t[1]);
            }
        }
        for (const ev of zaps) {
            if (parseZapReceipt(ev).sender !== me) continue; // verify the embedded request is yours (defends a forged #P)
            const e = [...ev.tags].reverse().find((t) => t[0] === 'e' && t[1]); // zapped note
            const a = e ? null : [...ev.tags].reverse().find((t) => t[0] === 'a' && t[1]); // or zapped article
            const key = e ? e[1]! : a ? addrToNaddr(a[1]!) : null; // articles keyed by canonical naddr
            if (key) u.zapped.add(key);
        }
        u.zapSync = Date.now();
        u.lastSync = Date.now();
        synced++;
        scheduleFlush();
    } finally {
        u.syncing = false;
    }
}

/** Stats for one user (no cross-user aggregation - /metrics is scoped to the caller). */
export function engagementStats(me: string): { liked: number; reposted: number; replied: number; zapped: number; lastSync: number; syncs: number; lookups: number } {
    const u = users.get(me);
    return { liked: u?.liked.size ?? 0, reposted: u?.reposted.size ?? 0, replied: u?.replied.size ?? 0, zapped: u?.zapped.size ?? 0, lastSync: u?.lastSync ?? 0, syncs: synced, lookups };
}
