// NIP-37 draft sync (cross-device). PER-DRAFT opt-in: a draft marked `synced` is published as
// an encrypted kind:31234 wrap (content = nip44-to-self of the inner draft event) to your draft
// relays (kind:10013, fallback to write relays); /drafts merges these with local by id. This is
// the BUNKER path (server-side encrypt/sign/decrypt); the nip07 path (encrypt/decrypt chains)
// comes later. Deletion / un-sync = re-publish the wrap with empty content (NIP-37).

import type { Session } from '../session.ts';
import type { NostrEvent, UnsignedEvent } from '../nostr/types.ts';
import type { Draft, ArticleDraft, NoteDraft, PollDraft } from '../drafts.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import {
    KIND_DRAFT, KIND_DRAFT_RELAYS, draftWrapTemplate, serializeDraft, parseDraft,
    parseDraftRelays, draftId, isDeletedDraft,
} from '../nostr/nip37.ts';

type Signed = Session & { me: string; signer: NonNullable<Session['signer']> };
type WithMe = Session & { me: string };

// --- draft <-> inner-event mapping ----------------------------------------
// Round-trips OUR composer state; the `k`/inner kind marks the draft's type. This is a draft
// (unsigned, never published as-is - the real publish path builds the final event), so a few
// composer-specific bits ride in extra tags (e.g. the poll duration INDEX) to round-trip exactly.

const topicTags = (topics: string): string[][] => topics.split(/[\s,]+/).filter(Boolean).map((t) => ['t', t]);

/** A local Draft -> the unsigned inner draft event we encrypt + wrap. */
export function draftToEvent(d: Draft, me: string): UnsignedEvent {
    // Local drafts store savedAt in MILLISECONDS; Nostr created_at is SECONDS.
    const base = { created_at: Math.floor((d.savedAt || Date.now()) / 1000), pubkey: me };
    if (d.type === 'article') {
        return {
            ...base, kind: 30023, content: d.body,
            tags: [['d', d.identifier], ['title', d.title], ['summary', d.summary],
                ...(d.image ? [['image', d.image]] : []), ...topicTags(d.topics)],
        };
    }
    if (d.type === 'poll') {
        return {
            ...base, kind: 1068, content: d.question,
            tags: [...d.options.map((o, i) => ['option', String(i), o]),
                ['polltype', d.multi ? 'multiplechoice' : 'singlechoice'],
                ['draftduration', String(d.duration)]],
        };
    }
    return { // note
        ...base, kind: 1, content: d.content,
        tags: [...d.imeta, ...(d.cw ? [['content-warning', d.cwReason]] : [])],
    };
}

/** A decrypted inner draft event (+ the wrap's id) -> a local Draft. Inverse of draftToEvent. */
export function eventToDraft(inner: UnsignedEvent, id: string): Draft | null {
    const tagVal = (k: string): string => inner.tags.find((t) => t[0] === k)?.[1] ?? '';
    const savedAt = inner.created_at * 1000; // back to the local MS convention
    if (inner.kind === 30023) {
        return {
            type: 'article', id, identifier: tagVal('d') || id,
            title: tagVal('title'), summary: tagVal('summary'), image: tagVal('image'),
            topics: inner.tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').join(' '),
            body: inner.content, savedAt, synced: true,
        } satisfies ArticleDraft;
    }
    if (inner.kind === 1068) {
        return {
            type: 'poll', id, question: inner.content,
            options: inner.tags.filter((t) => t[0] === 'option').map((t) => t[2] ?? t[1] ?? '').filter(Boolean),
            multi: tagVal('polltype') === 'multiplechoice',
            duration: Number(tagVal('draftduration')) || 0,
            savedAt, synced: true, syncedAt: savedAt,
        } satisfies PollDraft;
    }
    if (inner.kind === 1) {
        const cw = inner.tags.find((t) => t[0] === 'content-warning');
        return {
            type: 'note', id, content: inner.content,
            imeta: inner.tags.filter((t) => t[0] === 'imeta'),
            cw: !!cw, cwReason: cw?.[1] ?? '', savedAt, synced: true,
        } satisfies NoteDraft;
    }
    return null;
}

// --- relays + bunker publish/fetch ----------------------------------------

/** Your draft relays (kind:10013), or write relays + indexers if none published. Cached on the
 * session: the 10013 list is near-static, so repeat draft loads/saves don't re-`get` it - a /drafts
 * load drops from 2 round-trips (relay list + wraps) to 1 after the first resolve this session. */
async function draftRelays(s: WithMe): Promise<string[]> {
    if (s.draftRelays) return s.draftRelays;
    const ev = await s.pool.get([...(s.myRelays?.read ?? []), ...INDEXER_RELAYS], { kinds: [KIND_DRAFT_RELAYS], authors: [s.me] }).catch(() => null);
    const list = ev ? parseDraftRelays(ev) : [];
    return (s.draftRelays = list.length ? list : [...new Set([...(s.myRelays?.write ?? []), ...INDEXER_RELAYS])]);
}

/** Publish a draft as an encrypted NIP-37 wrap to your draft relays. Returns true on any accept. */
export async function syncDraft(s: Signed, d: Draft): Promise<boolean> {
    const inner = draftToEvent(d, s.me);
    const encrypted = await s.signer.nip44Encrypt(s.me, serializeDraft(inner));
    const signed = await s.signer.signEvent(draftWrapTemplate(s.me, d.id, inner.kind, encrypted)) as NostrEvent;
    const results = await s.pool.publish(await draftRelays(s), signed).catch(() => [] as PromiseSettledResult<string>[]);
    return results.some((r) => r.status === 'fulfilled');
}

/** Stop syncing: re-publish the wrap with empty content (NIP-37 deletion). `kind` = wrapped kind. */
export async function unsyncDraft(s: Signed, id: string, kind: number): Promise<void> {
    const signed = await s.signer.signEvent(draftWrapTemplate(s.me, id, kind, '')) as NostrEvent;
    await s.pool.publish(await draftRelays(s), signed).catch(() => []);
}

/** Fetch + decrypt your synced drafts (newest wrap per `d`; tombstones skipped). */
export async function fetchSyncedDrafts(s: Signed): Promise<Draft[]> {
    const wraps = await s.pool.query(await draftRelays(s), { kinds: [KIND_DRAFT], authors: [s.me] }).catch(() => [] as NostrEvent[]);
    const newest = new Map<string, NostrEvent>();
    for (const w of wraps) {
        const id = draftId(w);
        if (!id) continue;
        const cur = newest.get(id);
        if (!cur || w.created_at > cur.created_at) newest.set(id, w);
    }
    const out: Draft[] = [];
    for (const [id, w] of newest) {
        if (isDeletedDraft(w)) continue;
        try {
            const inner = parseDraft(await s.signer.nip44Decrypt(s.me, w.content));
            const d = inner && eventToDraft(inner, id);
            if (d) out.push(d);
        } catch { /* skip unreadable wrap */ }
    }
    return out;
}

// --- nip07 path helpers (publish needs no signer; decrypt/encrypt go through the chain) ----

/** Publish a (client-signed) draft wrap to your draft relays. Mode-agnostic (no signer). */
export async function publishDraftWrap(s: WithMe, signed: NostrEvent): Promise<boolean> {
    const results = await s.pool.publish(await draftRelays(s), signed).catch(() => [] as PromiseSettledResult<string>[]);
    return results.some((r) => r.status === 'fulfilled');
}

/** Fetch your draft wraps (newest per d, tombstones dropped) WITHOUT decrypting - for the
 * nip07 decrypt-on-load chain (the route batch-decrypts the contents via the extension). */
export async function fetchDraftWraps(s: WithMe): Promise<NostrEvent[]> {
    const wraps = await s.pool.query(await draftRelays(s), { kinds: [KIND_DRAFT], authors: [s.me] }).catch(() => [] as NostrEvent[]);
    const newest = new Map<string, NostrEvent>();
    for (const w of wraps) {
        const id = draftId(w);
        if (!id) continue;
        const cur = newest.get(id);
        if (!cur || w.created_at > cur.created_at) newest.set(id, w);
    }
    return [...newest.values()].filter((w) => !isDeletedDraft(w));
}

/** Build a Draft from a decrypted wrap content + its identifier (nip07 apply step). */
export function draftFromDecrypted(decrypted: string, id: string): Draft | null {
    const inner = parseDraft(decrypted);
    return inner ? eventToDraft(inner, id) : null;
}

