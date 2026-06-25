// NIP-88 poll responses: fetch the kind:1018 votes for a poll, and publish your
// own. Votes go to your write relays + the poll's own `relay` tags (per spec),
// so the author and other clients can find them.

import type { Pool } from './pool.ts';
import type { Signer } from './signer.ts';
import type { NostrEvent, RelayList } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { KIND_POLL_RESPONSE, buildResponseTags, parsePollRelays } from '../nostr/nip88.ts';

const now = () => Math.floor(Date.now() / 1000);
const writeRelays = (r: RelayList) => (r.write.length ? r.write : INDEXER_RELAYS);

/** Fetch kind:1018 responses referencing a poll. The net is necessarily wide +
 * approximate - votes scatter across voters' relays (outbox-model caveat). */
export async function fetchPollResponses(pool: Pool, pollId: string, relays: string[]): Promise<NostrEvent[]> {
    if (relays.length === 0) return [];
    return pool.query(relays, { kinds: [KIND_POLL_RESPONSE], '#e': [pollId], limit: 1000 }).catch(() => []);
}

/** Publish a vote (kind:1018) for a poll. */
export async function publishPollVote(signer: Signer, pool: Pool, me: string, myRelays: RelayList, poll: NostrEvent, optionIds: string[]): Promise<NostrEvent> {
    const signed = await signer.signEvent({
        kind: KIND_POLL_RESPONSE,
        created_at: now(),
        pubkey: me,
        content: '',
        tags: buildResponseTags(poll.id, optionIds),
    });
    const targets = [...new Set([...writeRelays(myRelays), ...parsePollRelays(poll)])];
    const results = await pool.publish(targets, signed);
    results.forEach((r) => { if (r.status === 'rejected') console.warn('[poll] relay rejected:', r.reason?.message ?? r.reason); });
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no relay accepted the vote');
    return signed;
}
