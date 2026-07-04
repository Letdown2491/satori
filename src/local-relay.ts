// Local relay: ONE optional personal relay (a self-hosted aggregator / outbox / blaster) the
// daemon can mirror writes to and/or read from. Kept OUT of your published NIP-65 list - it's
// daemon-side operational config, exactly like Privacy Mode (privacy.ts), decoupled from what
// other clients see. Per direction (read / write) it's a 3-way:
//   off  - don't use the local relay for this direction.
//   add  - UNION: the local relay alongside your normal outbox / write relays (type-agnostic
//          supplement; a thin relay costs nothing, an aggregator serves the whole feed).
//   only - EXCLUSIVE: talk ONLY to the local relay for this direction, skipping the outbox /
//          NIP-65 relays. This is the isolation you want to TEST a custom relay - if the feed
//          is empty or a post is lost, the relay isn't serving/accepting it.
// Server-wide (single-user daemon), persisted to .data, live-settable. Env SATORI_LOCAL_RELAY
// seeds the url (add/add) on first run.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeRelayUrl } from './nostr/nip65.ts';

export type RelayUse = 'off' | 'add' | 'only';
export const RELAY_USES: RelayUse[] = ['off', 'add', 'only'];
const isUse = (v: unknown): v is RelayUse => (RELAY_USES as unknown[]).includes(v);

export interface LocalRelay { url: string; read: RelayUse; write: RelayUse }

const FILE = process.env.SATORI_LOCAL_RELAY_FILE ?? '.data/local-relay.json';
let state: LocalRelay | null = null;

(function load(): void {
    try {
        const j = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<LocalRelay>;
        if (j && typeof j.url === 'string') {
            const url = normalizeRelayUrl(j.url, { assumeWss: true });
            if (url) { state = { url, read: isUse(j.read) ? j.read : 'add', write: isUse(j.write) ? j.write : 'add' }; return; }
        }
    } catch { /* no file yet - fall through to the env seed */ }
    const envUrl = process.env.SATORI_LOCAL_RELAY?.trim();
    if (envUrl) { const url = normalizeRelayUrl(envUrl, { assumeWss: true }); if (url) state = { url, read: 'add', write: 'add' }; }
})();

export function localRelay(): LocalRelay | null { return state; }

/** Set (url present + valid) or clear (blank/invalid url) the local relay. Returns the new state. */
export function setLocalRelay(url: string, read: RelayUse, write: RelayUse): LocalRelay | null {
    const norm = normalizeRelayUrl(url, { assumeWss: true });
    state = norm ? { url: norm, read, write } : null;
    try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(state ?? {}), { mode: 0o600 }); }
    catch (e) { console.warn('[local-relay] persist failed:', (e as Error)?.message ?? e); }
    return state;
}

/** How reads use the local relay (off if none configured). */
export const localReadMode = (): RelayUse => state?.read ?? 'off';
/** How writes use the local relay (off if none configured). */
export const localWriteMode = (): RelayUse => state?.write ?? 'off';
/** The local relay url, or null - regardless of read/write mode (used for the Tor bypass). */
export const localRelayUrl = (): string | null => state?.url ?? null;

/** True if `url` is the configured local relay. Used by the Tor bypass: a CLEARNET local relay
 * (e.g. ws://localhost) must not be forced through Tor by Privacy Mode (Tor can't reach it); an
 * .onion local relay still routes via Tor by nature (that path keys off the hostname, not this). */
export function isLocalRelayUrl(url: string): boolean {
    if (!state) return false;
    const norm = normalizeRelayUrl(url, { assumeWss: true });
    return !!norm && norm === state.url;
}
