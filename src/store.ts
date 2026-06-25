// Tiny on-disk session store so a server restart (or the dev container's
// --watch reload) doesn't log you out - it resumes the session from the cookie,
// mirroring Satori's "a reload resumes your session" (which used localStorage).
//
// What's persisted: the user pubkey + their NIP-65 relays, and for a bunker
// session the NIP-46 *transport* key (client secret, remote pubkey, relays) -
// the same thing Satori kept in localStorage. The user's nostr key is NOT here;
// it never leaves the bunker. nip07 sessions persist only the pubkey (no secret).
// File is written 0600 (owner-only); it's a local single-user daemon.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RelayList } from './nostr/types.ts';

export interface PersistedSession {
    mode: 'bunker' | 'nip07';
    me: string;
    myRelays: RelayList | null;
    bunker?: { secretHex: string; remotePubkey: string; relays: string[] };
    savedAt?: number; // ms epoch; stamped on save, used to prune stale entries (see prunePersisted)
    // (Read high-waters for the bell / new-notes dot moved to a client cookie -
    // see read-state.ts - so they're no longer persisted server-side here.)
}

const FILE = process.env.SATORI_SESSION_FILE || join(process.cwd(), '.data', 'sessions.json');

function readAll(): Record<string, PersistedSession> {
    try { return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, PersistedSession>; }
    catch { return {}; }
}

function writeAll(all: Record<string, PersistedSession>): void {
    try {
        mkdirSync(dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 });
    } catch (e) {
        console.warn('[store] could not persist sessions:', (e as Error)?.message ?? e);
    }
}

export function loadPersisted(sid: string): PersistedSession | undefined {
    return readAll()[sid];
}

export function savePersisted(sid: string, p: PersistedSession): void {
    const all = readAll();
    all[sid] = { ...p, savedAt: Date.now() };
    writeAll(all);
}

export function removePersisted(sid: string): void {
    const all = readAll();
    if (sid in all) { delete all[sid]; writeAll(all); }
}

/** Drop persisted sessions older than maxAgeMs (their cookies, maxAge 7d, are long dead, so
 * they can't be resumed anyway). Hygiene: keeps stale bunker transport secrets from lingering
 * at rest forever. Entries with no savedAt (pre-this-field) are kept until re-stamped on login.
 * Returns the number dropped. */
export function prunePersisted(maxAgeMs: number): number {
    const all = readAll();
    const now = Date.now();
    let dropped = 0;
    for (const [sid, p] of Object.entries(all)) {
        if (p.savedAt && now - p.savedAt > maxAgeMs) { delete all[sid]; dropped++; }
    }
    if (dropped) writeAll(all);
    return dropped;
}
