// Generic Nostr tag + value helpers (kind-agnostic). These were redefined per-file across routes/data/
// nostr; one home now. Imports only ./types.ts, so it's cycle-safe for any caller.

import type { NostrEvent } from './types.ts';

/** The first value of the first tag named `name` (`t[1]`), or '' when absent. */
export const tag1 = (ev: NostrEvent, name: string): string => ev.tags.find((t) => t[0] === name)?.[1] ?? '';

/** A 64-char hex id / pubkey. Case-INSENSITIVE (some sources emit uppercase); callers should lowercase
 * at the boundary if using the value as a tag/key. One canonical validator for every route. */
export const HEX64 = /^[0-9a-f]{64}$/i;
export const isHex64 = (s: string): boolean => HEX64.test(s);

/** Current unix time in SECONDS (Nostr's `created_at` unit). */
export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** The addressable coordinate `kind:pubkey:dtag` for an event. */
export const coordinateOf = (ev: NostrEvent): string => `${ev.kind}:${ev.pubkey}:${tag1(ev, 'd')}`;

/** The `relay` tag urls, de-duped and capped (default 8). Shared by the DM / draft / poll relay parsers. */
export const relayTags = (ev: NostrEvent, cap = 8): string[] =>
    [...new Set(ev.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]!))].slice(0, cap);
