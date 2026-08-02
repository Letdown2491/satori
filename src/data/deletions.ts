// NIP-09 deletion tombstones - the read side of event deletion. Kind:5 events are consumed
// at the pool chokepoint wherever they arrive and remembered here; every query/get result is
// then filtered against the store, so a deleted event stops rendering everywhere (feeds,
// threads, profiles, the embed cache) with no per-render network cost. The spec's MUST -
// only the author can delete their own event - is enforced structurally: id tombstones are
// KEYED by target-id + deleter-pubkey, so a lookup for an event only ever matches a deletion
// signed by that event's own author (someone else's kind:5 for the same id lands under a
// different key and never applies). Address (`a`) tombstones validate the coordinate's pubkey
// against the kind:5 author at record time, and apply only to versions with created_at at or
// before the deletion's - a later re-publish supersedes the delete, per NIP-09.
//
// PERSISTED (debounced + flush-on-exit): a tombstone must outlive the 30-min event caches and
// daemon restarts, or deleted events resurrect on reboot. Bounded like seen-relays.

import { join } from 'node:path';
import { jsonStore, debouncedFlush } from './json-store.ts';
import { HEX64, coordParts, coordinateOf, isAddressable } from '../nostr/tags.ts';
import type { NostrEvent } from '../nostr/types.ts';

const MAX_TOMBS = 5000;        // per map; a tombstone is ~100 bytes, so this stays a small file
const CHECK_TTL = 30 * 60_000; // don't re-ask relays about the same event's deletion for 30 min
const FILE = process.env.SATORI_DELETIONS_FILE || join(process.cwd(), '.data', 'deletions.json');

interface Stored extends Record<string, unknown> { ids?: Record<string, number>; addrs?: Record<string, number> }
const { readAll, writeAll } = jsonStore<Stored>(FILE, 'deletions');

// `${targetId}:${deleterPubkey}` → deletion created_at, and coordinate → deletion created_at.
// Map insertion order = recency; oldest entries are dropped first at the cap.
const stored = readAll();
const ids = new Map<string, number>(Object.entries(stored.ids ?? {}).slice(-MAX_TOMBS));
const addrs = new Map<string, number>(Object.entries(stored.addrs ?? {}).slice(-MAX_TOMBS));

const flusher = debouncedFlush(() => {
    writeAll({ ids: Object.fromEntries(ids), addrs: Object.fromEntries(addrs) });
}, 10000);

/** Keep the NEWEST deletion time per key, reinsert for recency, drop the oldest over the cap. */
function put(map: Map<string, number>, key: string, at: number): void {
    const cur = map.get(key);
    if (cur !== undefined && cur >= at) return;
    map.delete(key);
    map.set(key, at);
    while (map.size > MAX_TOMBS) map.delete(map.keys().next().value as string);
}

/** Record a kind:5's targets as tombstones. `e` targets are keyed with the deleter's pubkey
 * (pubkey-matching happens at lookup); `a` targets are only honored when the coordinate's
 * pubkey IS the kind:5 author (the NIP-09 MUST - anyone can e-tag, but an address names its
 * owner, so a mismatch is a cross-author deletion attempt and is dropped). */
export function recordDeletion(ev: NostrEvent): void {
    if (ev.kind !== 5) return;
    let touched = false;
    for (const t of ev.tags) {
        if (t[0] === 'e' && HEX64.test(t[1] ?? '')) {
            put(ids, `${t[1]!.toLowerCase()}:${ev.pubkey}`, ev.created_at);
            touched = true;
        } else if (t[0] === 'a' && t[1]) {
            const c = coordParts(t[1]);
            if (c && c.pubkey === ev.pubkey) { put(addrs, t[1], ev.created_at); touched = true; }
        }
    }
    if (touched) flusher.schedule();
}

/** Is this event deleted by its own author? Id tombstones match only when the deleter IS the
 * event's author (the key embeds both). Address tombstones suppress versions up to the
 * deletion time, so a re-published (newer) version renders again. */
export function isDeletedEvent(ev: NostrEvent): boolean {
    if (ids.has(`${ev.id}:${ev.pubkey}`)) return true;
    if (!isAddressable(ev.kind)) return false;
    const at = addrs.get(coordinateOf(ev));
    return at !== undefined && ev.created_at <= at;
}

// TTL memory for the background deletion sweep: which ids/coordinates we've recently asked
// relays about. In-memory only - a restart just re-checks once, which is fine.
const checked = new Map<string, number>();

/** Should the sweep ask relays about this target (id or coordinate)? True at most once per
 * TTL per target; marks the target as checked when it says yes. */
export function shouldCheckDeletion(key: string): boolean {
    const now = Date.now();
    const last = checked.get(key);
    if (last !== undefined && now - last < CHECK_TTL) return false;
    if (checked.size >= 20000) checked.clear(); // cheap bound; worst case is one early re-check
    checked.set(key, now);
    return true;
}
