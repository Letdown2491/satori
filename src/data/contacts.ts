// NIP-02 contact list (kind:3) - read who you follow, and follow/unfollow by
// editing + re-publishing the list. Following is plaintext p-tags; we preserve
// any other tags + the content blob (legacy relay JSON) untouched.

import type { Pool } from './pool.ts';
import type { Signer } from './signer.ts';
import type { NostrEvent, RelayList } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';

const now = () => Math.floor(Date.now() / 1000);
const writeRelays = (r: RelayList) => (r.write.length ? r.write : INDEXER_RELAYS);

/** Fetch your latest kind:3 contact list (newest wins). */
export async function fetchContactList(pool: Pool, me: string, myRelays: RelayList): Promise<NostrEvent | null> {
    const relays = [...new Set([...myRelays.write, ...myRelays.read, ...INDEXER_RELAYS])];
    const events = await pool.query(relays, { kinds: [3], authors: [me] }).catch(() => []);
    return events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/** The followed pubkeys (`p` tags) in a contact list. */
export function contactPubkeys(ev: NostrEvent | null): string[] {
    return ev ? ev.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]!) : [];
}

/** Follow or unfollow a pubkey by editing the list and re-publishing. */
export async function publishContactList(
    signer: Signer, pool: Pool, me: string, myRelays: RelayList,
    prev: NostrEvent | null, pubkey: string, follow: boolean,
): Promise<NostrEvent> {
    const tags = (prev?.tags ?? []).filter((t) => !(t[0] === 'p' && t[1] === pubkey));
    if (follow) tags.push(['p', pubkey]);
    const signed = await signer.signEvent({ kind: 3, created_at: now(), pubkey: me, content: prev?.content ?? '', tags });
    const results = await pool.publish(writeRelays(myRelays), signed);
    results.forEach((r) => { if (r.status === 'rejected') console.warn('[follow] relay rejected:', r.reason?.message ?? r.reason); });
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no relay accepted the follow update');
    return signed;
}
