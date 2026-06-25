// NIP-50 search - notes (kind:1) and people (kind:0) over dedicated search relays.
// nostr has no decentralized full-text index, so search centralizes on a handful of
// indexer relays; these defaults were liveness-tested 2026-06-20 (borrowed from
// ants.sh's vetted lists). Relays rot - see [[search-plan]]; making these a Settings
// field is the immediate follow-up (kept as constants for v1). pool.query already
// caps each query with maxWait, so a dead/slow source just contributes nothing.

import type { Pool } from './pool.ts';
import type { NostrEvent } from '../nostr/types.ts';
import { parseProfile, type Profile } from './profiles.ts';

export const SEARCH_NOTE_RELAYS = [
    'wss://search.nos.today',
    'wss://relay.ditto.pub',
    'wss://antiprimal.net',
];
export const SEARCH_PROFILE_RELAYS = [
    'wss://relay.ditto.pub',
    'wss://relay.vertexlab.io',
    'wss://antiprimal.net',
    'wss://nostr.wine',
];

/** Full-text note search: query the note relays, merge + dedupe by id, newest first. */
export async function searchNotes(pool: Pool, relays: string[], q: string, limit = 30): Promise<NostrEvent[]> {
    const events = await pool.query(relays, { kinds: [1], search: q, limit }).catch(() => [] as NostrEvent[]);
    const byId = new Map<string, NostrEvent>();
    for (const ev of events) if (!byId.has(ev.id)) byId.set(ev.id, ev);
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

/** People search: kind:0 full-text → newest profile per pubkey, parsed for rendering. */
export async function searchPeople(pool: Pool, relays: string[], q: string, limit = 20): Promise<{ pubkey: string; profile: Profile }[]> {
    const events = await pool.query(relays, { kinds: [0], search: q, limit: limit * 2 }).catch(() => [] as NostrEvent[]);
    const newest = new Map<string, NostrEvent>();
    for (const ev of events) {
        const cur = newest.get(ev.pubkey);
        if (!cur || ev.created_at > cur.created_at) newest.set(ev.pubkey, ev);
    }
    const out: { pubkey: string; profile: Profile }[] = [];
    for (const ev of newest.values()) {
        const profile = parseProfile(ev.content, ev.tags);
        if (profile) out.push({ pubkey: ev.pubkey, profile });
    }
    return out.slice(0, limit);
}
