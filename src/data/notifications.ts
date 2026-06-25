// Notifications - relationship signals addressed to you, mirroring Satori's
// data/notifications.ts. From your READ (inbox) relays: replies + mentions
// (kind:1 #p=you), zaps you received (kind:9735 #p=you), and votes on your polls
// (kind:1018 #e=your poll ids). No likes/reposts (deliberately omitted), no
// counts. Newest first, paged by time (?until cursor).

import type { Pool } from './pool.ts';
import type { NostrEvent, RelayList } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { KIND_POLL, KIND_POLL_RESPONSE } from '../nostr/nip88.ts';

export type NotifType = 'reply' | 'mention' | 'pollvote' | 'zap' | 'reaction' | 'privateReply';
export interface Notif { type: NotifType; event: NostrEvent }
export interface NotifWindow { since?: number; until?: number; limit: number }

/** Your poll ids (kind:1068), so vote-notifications can be paged alongside the rest. */
export async function fetchMyPollIds(pool: Pool, me: string, myRelays: RelayList | null): Promise<string[]> {
    const write = myRelays?.write.length ? myRelays.write : INDEXER_RELAYS;
    const polls = await pool.query(write, { kinds: [KIND_POLL], authors: [me], limit: 50 }).catch(() => [] as NostrEvent[]);
    return polls.map((p) => p.id);
}

/** Fetch notifications addressed to `me` within a time window, newest first. */
export async function fetchNotifications(
    pool: Pool, me: string, myRelays: RelayList | null, pollIds: string[], win: NotifWindow, includeReactions = false,
): Promise<Notif[]> {
    const read = myRelays?.read.length ? myRelays.read : INDEXER_RELAYS;
    const bounds = {
        ...(win.since !== undefined ? { since: win.since } : {}),
        ...(win.until !== undefined ? { until: win.until } : {}),
    };
    // kind:7 reactions are only queried when the "reactions in notifications" pref is on (off by default).
    const taggedKinds = includeReactions ? [1, 7, 9735] : [1, 9735];
    // Over-fetch each stream (2x), merge, then slice to `limit`: the page's oldest item then sits
    // ABOVE each stream's own oldest, so the `until` cursor for the next page can't skip events in
    // the gap between the two streams' tails (the feed paginates the same way). One round-trip each.
    const fetchLimit = win.limit * 2;
    const [tagged, votes] = await Promise.all([
        pool.query(read, { kinds: taggedKinds, '#p': [me], limit: fetchLimit, ...bounds }).catch(() => [] as NostrEvent[]),
        pollIds.length
            ? pool.query(read, { kinds: [KIND_POLL_RESPONSE], '#e': pollIds, limit: fetchLimit, ...bounds }).catch(() => [] as NostrEvent[])
            : Promise.resolve([] as NostrEvent[]),
    ]);

    const items: Notif[] = [];
    const seen = new Set<string>();
    const add = (type: NotifType, ev: NostrEvent) => {
        if (ev.pubkey === me || seen.has(ev.id)) return; // skip your own actions / dupes
        seen.add(ev.id);
        items.push({ type, event: ev });
    };
    for (const ev of tagged) {
        if (ev.kind === 9735) add('zap', ev);
        else if (ev.kind === 7) add('reaction', ev); // before the e-tag check (a reaction carries an e tag)
        else add(ev.tags.some((t) => t[0] === 'e') ? 'reply' : 'mention', ev);
    }
    for (const ev of votes) add('pollvote', ev);

    items.sort((a, b) => b.event.created_at - a.event.created_at);
    return items.slice(0, win.limit);
}

export interface ZapInfo { sender: string | null; sats: number }

/** Msats encoded in a bolt11 invoice's HRP (`lnbc<amount><multiplier>`). The amount itself
 * contains digits, so we anchor on the `[munp]?` multiplier before the bech32 `1` separator
 * rather than splitting on `1`. Returns 0 for an amountless ("any amount") invoice. */
function msatsFromBolt11(invoice: string): number {
    const m = invoice.toLowerCase().match(/^lnbc(\d+)([munp]?)1/);
    if (!m) return 0;
    const amount = Number(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    switch (m[2]) {
        case 'm': return amount * 1e8;   // milli-BTC
        case 'u': return amount * 1e5;   // micro-BTC
        case 'n': return amount * 1e2;   // nano-BTC
        case 'p': return amount / 10;    // pico-BTC (must be a multiple of 10 msat)
        default: return amount * 1e11;   // bare = whole BTC
    }
}

/** Pull the sender + sats out of a kind:9735 zap receipt (from its embedded kind:9734 request
 * in the `description` tag). The request's `amount` tag is optional, so fall back to the
 * authoritative amount in the receipt's bolt11 invoice rather than showing "0 sats". */
export function parseZapReceipt(ev: NostrEvent): ZapInfo {
    const desc = ev.tags.find((t) => t[0] === 'description')?.[1];
    let sender: string | null = null;
    let msats = 0;
    if (desc) {
        try {
            const req = JSON.parse(desc) as NostrEvent;
            sender = req.pubkey ?? null;
            const amt = req.tags?.find((t) => t[0] === 'amount')?.[1];
            if (amt) msats = Number(amt) || 0;
        } catch { /* malformed */ }
    }
    if (msats === 0) {
        const bolt11 = ev.tags.find((t) => t[0] === 'bolt11')?.[1];
        if (bolt11) msats = msatsFromBolt11(bolt11);
    }
    return { sender, sats: Math.round(msats / 1000) };
}
