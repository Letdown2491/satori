// Composing + publishing notes/replies. Split into sign (the remote-signer
// round-trip the UI waits on) and publish (background relay fan-out).

import type { Pool } from './pool.ts';
import type { Signer } from './signer.ts';
import type { NostrEvent, RelayList } from '../nostr/types.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { fetchRelayLists } from './relays.ts';
import { KIND_POLL, generateOptionId, buildPollTags } from '../nostr/nip88.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';
import type { PollType } from '../nostr/nip88.ts';
import { tokenize } from '../nostr/content.ts';

const MAX_INBOX_RELAYS = 4;

export interface ReplyTo { id: string; pubkey?: string }
export interface QuoteRef { id: string; pubkey?: string; relays?: string[]; address?: string }

/** A NIP-22 reference: an article (address + kind 30023) or a comment (id + kind 1111). */
export interface CommentRef { kind: number; pubkey: string; address?: string; id?: string }
export interface CommentTarget { root: CommentRef; parent: CommentRef }

export interface Prepared {
    signed: NostrEvent;
    isReply: boolean;
    writeTargets: string[];  // your outbox
    inboxTargets: string[];  // recipient's inbox (replies)
}

export interface DeliveryReport { url: string; ok: boolean }

/** Build + sign a note (or reply). Resolves the recipient's relays for the NIP-10
 * hints + inbox delivery. Does NOT publish - returns what publishSigned needs. */
export async function signNote(
    signer: Signer,
    pool: Pool,
    me: string,
    myRelays: RelayList,
    { content, replyTo = null, quote = null, imeta = [], contentWarning = null, createdAt }:
        { content: string; replyTo?: ReplyTo | null; quote?: QuoteRef | null; imeta?: string[][]; contentWarning?: string | null; createdAt?: number },
): Promise<Prepared> {
    const tags: string[][] = [];
    const inboxRelays: string[] = [];
    if (contentWarning !== null) tags.push(contentWarning ? ['content-warning', contentWarning] : ['content-warning']);
    for (const m of imeta) tags.push(m); // NIP-92 metadata for uploaded media

    // NIP-18 quote: the nostr:nevent/naddr already sits in the content (rendered
    // as a quote/article card); the reference tag + author `p` make it a quote.
    if (quote?.address) {
        tags.push(['q', quote.address, quote.relays?.[0] ?? '', quote.pubkey ?? '']);
        if (quote.pubkey) tags.push(['p', quote.pubkey]);
    } else if (quote?.id) {
        tags.push(['q', quote.id, quote.relays?.[0] ?? '', quote.pubkey ?? '']);
        if (quote.pubkey) tags.push(['p', quote.pubkey]);
    }

    if (replyTo?.id) {
        let recipientList: RelayList | null = null;
        if (replyTo.pubkey) {
            const lists = await fetchRelayLists(pool, INDEXER_RELAYS, [replyTo.pubkey]).catch(() => new Map<string, RelayList>());
            recipientList = lists.get(replyTo.pubkey) ?? null;
        }
        const writeHint = recipientList?.write[0] ?? '';
        const readHint = recipientList?.read[0] ?? '';
        tags.push(['e', replyTo.id, writeHint, 'reply']);
        if (replyTo.pubkey) tags.push(['p', replyTo.pubkey, readHint]);
        const read = recipientList?.read ?? [];
        inboxRelays.push(...(read.length ? read : INDEXER_RELAYS).slice(0, MAX_INBOX_RELAYS));
    }

    // p-tag any @mentions in the content (so the mentioned users are notified).
    const tagged = new Set(tags.filter((t) => t[0] === 'p').map((t) => t[1]));
    for (const tok of tokenize(content)) {
        if (tok.t === 'mention' && !tagged.has(tok.pubkey)) { tags.push(['p', tok.pubkey]); tagged.add(tok.pubkey); }
    }

    const signed = await signer.signEvent({
        kind: 1,
        created_at: createdAt ?? Math.floor(Date.now() / 1000), // a scheduled post bakes in its future time
        tags,
        content,
        pubkey: me,
    });
    const myWrite = myRelays.write.length ? myRelays.write : INDEXER_RELAYS;
    return { signed, isReply: !!replyTo?.id, writeTargets: myWrite, inboxTargets: inboxRelays };
}

/** Build + sign a NIP-22 comment (kind:1111) - root scope in uppercase tags, the
 * immediate parent in lowercase. Used for article comments (top-level + nested). */
export async function signComment(
    signer: Signer,
    pool: Pool,
    me: string,
    myRelays: RelayList,
    { content, comment, contentWarning = null }: { content: string; comment: CommentTarget; contentWarning?: string | null },
): Promise<Prepared> {
    const { root, parent } = comment;
    const lists = await fetchRelayLists(pool, INDEXER_RELAYS, [parent.pubkey]).catch(() => new Map<string, RelayList>());
    const recipientList = lists.get(parent.pubkey) ?? null;
    const writeHint = recipientList?.write[0] ?? '';
    const readHint = recipientList?.read[0] ?? '';

    const tags: string[][] = [];
    if (contentWarning !== null) tags.push(contentWarning ? ['content-warning', contentWarning] : ['content-warning']);
    // root (uppercase)
    tags.push(root.address ? ['A', root.address, writeHint] : ['E', root.id!, writeHint]);
    tags.push(['K', String(root.kind)], ['P', root.pubkey, readHint]);
    // parent (lowercase)
    tags.push(parent.address ? ['a', parent.address, writeHint] : ['e', parent.id!, writeHint]);
    tags.push(['k', String(parent.kind)], ['p', parent.pubkey, readHint]);

    const signed = await signer.signEvent({ kind: 1111, created_at: Math.floor(Date.now() / 1000), tags, content, pubkey: me });
    const myWrite = myRelays.write.length ? myRelays.write : INDEXER_RELAYS;
    const read = recipientList?.read ?? [];
    return { signed, isReply: true, writeTargets: myWrite, inboxTargets: (read.length ? read : INDEXER_RELAYS).slice(0, MAX_INBOX_RELAYS) };
}

/** Build + sign a poll (kind:1068). Votes are routed to your write relays (the
 * poll's `relay` tags), where readers will publish their kind:1018 responses. */
export async function signPoll(
    signer: Signer,
    me: string,
    myRelays: RelayList,
    { question, options, multiple, endsAt }:
        { question: string; options: string[]; multiple: boolean; endsAt: number | null },
): Promise<Prepared> {
    const myWrite = myRelays.write.length ? myRelays.write : INDEXER_RELAYS;
    const opts = options.map((label) => ({ id: generateOptionId(), label }));
    const type: PollType = multiple ? 'multiple' : 'single';
    const tags = buildPollTags(opts, type, endsAt, myWrite);
    const signed = await signer.signEvent({
        kind: KIND_POLL,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: question,
        pubkey: me,
    });
    return { signed, isReply: false, writeTargets: myWrite, inboxTargets: [] };
}

export interface ArticleFields {
    identifier: string;   // the `d` slug (stable across edits → updates, not duplicates)
    title: string;
    summary?: string;
    image?: string;
    topics?: string[];
    body: string;         // markdown
    publishedAt?: number; // preserved on edit; set to now on first publish
}

/** Build + sign a long-form article (NIP-23 kind:30023). */
export async function signArticle(signer: Signer, me: string, myRelays: RelayList, a: ArticleFields): Promise<Prepared> {
    const tags: string[][] = [['d', a.identifier], ['title', a.title]];
    if (a.summary) tags.push(['summary', a.summary]);
    if (a.image) tags.push(['image', a.image]);
    tags.push(['published_at', String(a.publishedAt ?? Math.floor(Date.now() / 1000))]);
    for (const t of a.topics ?? []) if (t) tags.push(['t', t]);
    const signed = await signer.signEvent({
        kind: KIND_ARTICLE,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: a.body,
        pubkey: me,
    });
    const myWrite = myRelays.write.length ? myRelays.write : INDEXER_RELAYS;
    return { signed, isReply: false, writeTargets: myWrite, inboxTargets: [] };
}

/** Publish a signed note to your write relays + recipient inbox. Succeeds if at
 * least one of your write relays accepts. */
export async function publishSigned(pool: Pool, prepared: Prepared): Promise<{ write: DeliveryReport[]; inbox: DeliveryReport[] }> {
    const { signed, writeTargets, inboxTargets } = prepared;
    const targets = [...writeTargets, ...inboxTargets];
    const results = await pool.publish(targets, signed);
    const report: DeliveryReport[] = results.map((r, i) => ({ url: targets[i]!, ok: r.status === 'fulfilled' }));
    report.forEach((r) => { if (!r.ok) console.warn(`[publish] ${r.url} rejected`); });
    const write = report.slice(0, writeTargets.length);
    const inbox = report.slice(writeTargets.length);
    if (!write.some((r) => r.ok)) throw new Error('Failed to publish to any of your write relays');
    return { write, inbox };
}
