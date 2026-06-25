// Scheduled posts: a note SIGNED at compose, held on disk, and broadcast by a periodic sweep
// at its time. The key is only needed at compose (to sign); broadcasting a fully-signed event
// needs no key, so a scheduled post goes out even with the browser closed (nip07) - the always-on
// daemon does it. `signed.created_at` == the scheduled time, broadcast AT that moment so it reads
// as ≈now and relays don't reject future-dating. Mirrors undo-store.ts. File 0600 under .data/.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool } from './pool.ts';
import type { NostrEvent } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';

export interface ScheduledPost {
    token: string;
    pubkey: string;          // author (== signed.pubkey)
    signed: NostrEvent;      // fully-signed kind:1; created_at == scheduledAt
    scheduledAt: number;     // unix SECONDS to broadcast at
    writeTargets: string[];  // relays to broadcast to (your outbox)
}

const FILE = process.env.SATORI_SCHEDULED_FILE || join(process.cwd(), '.data', 'scheduled.json');
const GIVE_UP_SECS = 3600; // stop retrying a post that keeps failing after 1h past its time

// mtime-keyed parse cache: the 30s sweep calls readAll() every tick, but the file only changes when
// we add/cancel/drop. Re-parse only when mtime moved (a statSync is far cheaper than read+JSON.parse,
// which matters for the common zero-scheduled-posts case running forever). Writes null the cache.
let parsed: { mtime: number; data: Record<string, ScheduledPost> } | null = null;
function readAll(): Record<string, ScheduledPost> {
    try {
        const mtime = statSync(FILE).mtimeMs;
        if (parsed && parsed.mtime === mtime) return parsed.data;
        const data = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, ScheduledPost>;
        parsed = { mtime, data };
        return data;
    } catch { parsed = null; return {}; }
}
function writeAll(all: Record<string, ScheduledPost>): void {
    try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 }); }
    catch (e) { console.warn('[scheduled] could not persist:', (e as Error)?.message ?? e); }
    parsed = null; // the in-memory copy may have been mutated by the caller; re-read fresh next time
}

export function addScheduled(p: ScheduledPost): void {
    const all = readAll(); all[p.token] = p; writeAll(all);
}
export function listScheduled(me: string): ScheduledPost[] {
    return Object.values(readAll()).filter((p) => p.pubkey === me).sort((a, b) => a.scheduledAt - b.scheduledAt);
}
export function getScheduledPost(me: string, token: string): ScheduledPost | null {
    const p = readAll()[token];
    return p && p.pubkey === me ? p : null;
}
export function cancelScheduled(me: string, token: string): boolean {
    const all = readAll();
    if (all[token]?.pubkey === me) { delete all[token]; writeAll(all); return true; }
    return false;
}

let sweeping = false;
/** Broadcast due posts (scheduledAt <= now); drop on success, or after GIVE_UP_SECS of failing.
 * Re-reads the store each tick, so it's restart-safe and needs no per-post timers. */
export async function sweepScheduled(pool: Pool): Promise<void> {
    if (sweeping) return; // never overlap a slow sweep
    sweeping = true;
    try {
        const now = Math.floor(Date.now() / 1000);
        // Skip any entry whose stored pubkey doesn't match its signed event (corrupt store): the
        // signed event is self-authenticating, but don't waste a broadcast on a mismatch.
        const due = Object.values(readAll()).filter((p) => p.scheduledAt <= now && p.signed?.pubkey === p.pubkey);
        const remove: string[] = [];
        for (const p of due) {
            const targets = p.writeTargets.length ? p.writeTargets : INDEXER_RELAYS;
            let ok = false;
            try {
                const results = await pool.publish(targets, p.signed);
                ok = results.some((r) => r.status === 'fulfilled');
            } catch (e) { console.warn('[scheduled] publish failed', p.token, (e as Error)?.message ?? e); }
            if (ok) remove.push(p.token);
            else if (now - p.scheduledAt > GIVE_UP_SECS) { console.warn('[scheduled] giving up on', p.token); remove.push(p.token); }
            // else: keep it and retry on the next sweep (relay may be transiently down)
        }
        if (remove.length) dropMany(remove); // one read+write for the whole sweep, not per post
    } finally { sweeping = false; }
}

/** Remove several tokens in a single read+write (the sweep can clear many due posts at once). */
function dropMany(tokens: string[]): void {
    const all = readAll();
    let changed = false;
    for (const t of tokens) if (t in all) { delete all[t]; changed = true; }
    if (changed) writeAll(all);
}

/** Start the periodic sweep (call once at boot, after the pool is ready). */
export function startScheduledSweep(pool: Pool, intervalMs = 30_000): void {
    void sweepScheduled(pool); // catch anything already due at boot
    setInterval(() => void sweepScheduled(pool), intervalMs);
}
