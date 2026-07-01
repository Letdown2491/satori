// Publish a long-form article (NIP-23, kind:30023). Mirrors postNote: bunker
// signs + publishes here (303 → the article reader); nip07 signs via the capture
// signer so the SAME signArticle builds the tags, the extension signs it, and
// POST /article/publish verifies + publishes + lands on the reader.

import { randomBytes } from 'node:crypto';
import { naddrEncode } from 'nostr-tools/nip19';
import { signArticle, publishSigned, captureSigner, type ArticleFields } from '../data/publish.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';
import { articleReader } from '../render/note.ts';
import { articleComposePage, draftsView, draftsScreen, draftRow, draftsSyncShell, draftDomId, draftSyncStatus, autoSyncTrigger, type ArticleComposeCtx } from '../render/article-compose.ts';
import { saveDraft, listDrafts, getDraft, deleteDraft, type ArticleDraft, type Draft } from '../drafts.ts';
import { holdScheduled, SCHEDULE_FULL_MSG, listScheduled } from '../data/scheduled.ts';
import { syncDraft, unsyncDraft, fetchSyncedDrafts, draftToEvent, publishDraftWrap, fetchDraftWraps, draftFromDecrypted } from '../data/draft-sync.ts';
import { serializeDraft, draftWrapTemplate, KIND_DRAFT } from '../nostr/nip37.ts';
import { page } from '../render/layout.ts';
import { html, type SafeHtml } from '../html.ts';
import { readSignedEvent, readSignResult, verifySigned } from '../nip07.ts';
import { requireLogin, ensureProfiles, chromeFor } from './common.ts';
import { readForm, redirect, sendPage, sendFragment, sendSignRequest, readBatchResults, type Ctx } from '../http.ts';
import type { Session } from '../session.ts';
import { signsOnClient } from '../session.ts';
import type { NostrEvent } from '../nostr/types.ts';

function readFields(form: URLSearchParams): ArticleFields {
    return {
        identifier: (form.get('identifier') ?? '').trim() || randomBytes(8).toString('hex'),
        title: (form.get('title') ?? '').trim(),
        summary: (form.get('summary') ?? '').trim() || undefined,
        image: (form.get('image') ?? '').trim() || undefined,
        topics: (form.get('topics') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        body: (form.get('body') ?? '').trim(),
    };
}

const naddrOf = (s: Session & { me: string }, identifier: string): string => {
    try { return naddrEncode({ identifier, pubkey: s.me, kind: KIND_ARTICLE, relays: (s.myRelays?.write ?? []).slice(0, 2) }); }
    catch { return ''; }
};

export async function postArticle(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const form = await readForm(ctx.req);
    const f = readFields(form);

    const back = (error: string): void => {
        const c: ArticleComposeCtx = {
            identifier: form.get('identifier') || undefined, title: form.get('title') ?? '', summary: form.get('summary') ?? '',
            image: form.get('image') ?? '', topics: form.get('topics') ?? '', body: form.get('body') ?? '', error,
        };
        sendPage(ctx, articleComposePage(c), chromeFor(ctx, s, { active: 'compose', title: 'Article' }), 400);
    };
    if (!f.title) { back('Add a title.'); return; }
    if (!f.body) { back('Write something first.'); return; }

    // Schedule: sign now with created_at = the chosen time, hold on disk, the sweep broadcasts it then.
    // The editable draft is KEPT (a scheduled article can only be cancelled, not edited; cancelling reverts
    // to the draft), so we skip the draft-wrap retire dance here.
    let scheduledAt = 0;
    if (form.get('do') === 'schedule') {
        const t = new Date((form.get('schedule') ?? '').trim()).getTime();
        scheduledAt = isNaN(t) ? 0 : Math.floor(t / 1000);
        if (!scheduledAt || scheduledAt <= Math.floor(Date.now() / 1000)) { back('Pick a time in the future to schedule.'); return; }
    }
    const fields: ArticleFields = scheduledAt ? { ...f, createdAt: scheduledAt } : f;

    // nip07: build the exact 30023 template; the extension signs it. If this draft was synced,
    // batch-sign the article + a BLANK wrap (one prompt) so publishing also retires the draft wrap
    // (else it would resurrect on the next /drafts load). Scheduling keeps the draft, so it skips that.
    if (signsOnClient(s)) {
        const prepared = await signArticle(captureSigner, s.me, s.myRelays!, fields);
        if (scheduledAt) {
            sendSignRequest(ctx, prepared.signed, `/article/publish?d=${encodeURIComponent(f.identifier)}&schedule=${scheduledAt}`);
            return;
        }
        const draft = getDraft(s.me, f.identifier);
        if (draft?.synced) {
            const blank = draftWrapTemplate(s.me, f.identifier, draftToEvent(draft, s.me).kind, '');
            sendSignRequest(ctx, { templates: [prepared.signed, blank] }, `/article/publish?d=${encodeURIComponent(f.identifier)}&retire=1`, 'sign_event_batch');
        } else {
            sendSignRequest(ctx, prepared.signed, `/article/publish?d=${encodeURIComponent(f.identifier)}`);
        }
        return;
    }

    // bunker: sign + publish (or hold for the sweep) here, then land on the reader (or /drafts).
    try {
        const prepared = await signArticle(s.signer!, s.me, s.myRelays!, fields);
        if (scheduledAt) {
            if (!holdScheduled(s.me, prepared.signed, scheduledAt, prepared.writeTargets)) { back(SCHEDULE_FULL_MSG); return; }
            redirect(ctx, '/drafts');
            return;
        }
        await publishSigned(s.pool, prepared);
    } catch (err) {
        back(`Couldn't publish: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    await clearDraftAndWrap(s, f.identifier); // published → clear its draft (+ retire the wrap)
    redirect(ctx, `/a/${naddrOf(s, f.identifier)}`);
}

/** POST /draft - save (or update) the article composer's draft, re-render the
 * composer with the id wired in (so the next save updates the same draft) + a
 * "saved" status. The Save-draft button posts here via `formaction`. */
export async function postDraft(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const form = await readForm(ctx.req);
    const identifier = (form.get('identifier') ?? '').trim() || randomBytes(8).toString('hex');
    const draft: ArticleDraft = {
        type: 'article', id: identifier, identifier,
        title: (form.get('title') ?? '').trim(),
        summary: (form.get('summary') ?? '').trim(),
        image: (form.get('image') ?? '').trim(),
        topics: (form.get('topics') ?? '').trim(),
        body: form.get('body') ?? '',
        savedAt: Date.now(),
        synced: getDraft(s.me, identifier)?.synced,
        syncedAt: getDraft(s.me, identifier)?.syncedAt,
    };
    saveDraft(s.me, draft);
    const syncEl = await composeSyncEl(s, draft); // auto-sync to relays (bunker inline; nip07 trigger)
    const c: ArticleComposeCtx = { ...draft, status: 'Draft saved ✓', syncEl };
    sendPage(ctx, articleComposePage(c), chromeFor(ctx, s, { active: 'compose', title: 'Article' }));
}

// --- drafts list + per-draft NIP-37 sync (bunker = inline; nip07 = encrypt/sign/decrypt chains) ---
type Signed = Session & { me: string; signer: NonNullable<Session['signer']> };
const canSync = (s: Session & { me: string }): s is Signed => s.mode === 'bunker' && !!s.signer;
const PLACE_ROW = (id: string) => ({ 'H-Reswap': 'outer', 'H-Retarget': `#${draftDomId(id)}` });
const PLACE_LIST = { 'H-Reswap': 'outer', 'H-Retarget': '#drafts-view' };
const PLACE_STATUS = { 'H-Reswap': 'outer', 'H-Retarget': '#draft-sync-status' };

/** Merge fetched synced drafts into the local store (newest wins; mark local copies synced). */
function mergeSynced(me: string, synced: Draft[]): void {
    const local = new Map(listDrafts(me).map((d) => [d.id, d]));
    for (const r of synced) {
        const cur = local.get(r.id);
        if (!cur) saveDraft(me, r);                                  // new from another device
        else if (r.savedAt > cur.savedAt) saveDraft(me, r);         // relay copy is newer
        else if (!cur.synced) saveDraft(me, { ...cur, synced: true }); // mark the local one synced
    }
}

/** The composer-foot auto-sync element after a save: BUNKER syncs inline (silent) and shows a
 * "synced" status; NIP07 returns a one-shot trigger that runs the encrypt/sign/publish chain on
 * insert (shows "syncing…" then "synced"). Sync is automatic - there are no manual controls. */
export async function composeSyncEl(s: Session & { me: string }, d: Draft): Promise<SafeHtml> {
    if (canSync(s)) {
        let ok = false;
        try { ok = await syncDraft(s, d); } catch { /* best-effort */ }
        if (ok) saveDraft(s.me, { ...d, synced: true, syncedAt: d.savedAt });
        return draftSyncStatus(true);
    }
    return autoSyncTrigger(d.id);
}

/** Re-render after a sync step: the composer status (nip07 chain, ?widget) or a /drafts row. */
function syncRerender(ctx: Ctx, d: Draft | null): void {
    if (ctx.query.get('widget')) { sendFragment(ctx, draftSyncStatus(!!d?.synced), PLACE_STATUS); return; }
    sendFragment(ctx, d ? draftRow(d) : html``, d ? PLACE_ROW(d.id) : {});
}

/** GET /drafts - your saved drafts. Bunker merges synced inline; nip07 renders local now + a
 * decrypt-on-load shell that pulls your synced wraps in. */
export async function getDrafts(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const chrome = chromeFor(ctx, s, { active: 'drafts', title: 'Drafts' });
    if (canSync(s)) {
        mergeSynced(s.me, await fetchSyncedDrafts(s).catch(() => []));
        sendPage(ctx, draftsScreen(listScheduled(s.me), listDrafts(s.me)), chrome);
        return;
    }
    sendPage(ctx, html`${draftsScreen(listScheduled(s.me), listDrafts(s.me))}${draftsSyncShell()}`, chrome);
}

/** POST /draft/sync/:id - auto-sync (publish the encrypted wrap). Triggered automatically (the
 * nip07 composer trigger, or the decrypt-load); never a manual control. Bunker inline; nip07 chains. */
export async function postDraftSync(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const id = ctx.params.id ?? '';
    const d = getDraft(s.me, id);
    if (!d) { syncRerender(ctx, null); return; }
    const next = { ...d, synced: true } as Draft;
    saveDraft(s.me, next);
    const inner = draftToEvent(next, s.me);
    if (canSync(s)) { // bunker: inline (rarely hit - bunker syncs in the save handler)
        let ok = false;
        try { ok = await syncDraft(s, next); } catch { /* best-effort */ }
        if (ok) { next.syncedAt = next.savedAt; saveDraft(s.me, next); }
        syncRerender(ctx, next);
        return;
    }
    if (!ctx.isPartial) { redirect(ctx, '/drafts'); return; } // nip07 needs JS (the chain)
    const w = ctx.query.get('widget') ? '&widget=1' : '';
    sendSignRequest(ctx, { pubkey: s.me, plaintext: serializeDraft(inner) }, `/draft/sync/${encodeURIComponent(id)}/wrap?kind=${inner.kind}${w}`, 'nip44_encrypt');
}

/** nip07 continuation: encrypted content in -> sign the wrap. */
export async function postDraftSyncWrap(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const id = ctx.params.id ?? '';
    const kind = Number(ctx.query.get('kind')) || 1;
    const ciphertext = await readSignResult(ctx.req);
    const cur = getDraft(s.me, id);
    if (typeof ciphertext !== 'string' || !cur) { syncRerender(ctx, cur); return; }
    const w = ctx.query.get('widget') ? '?widget=1' : '';
    sendSignRequest(ctx, draftWrapTemplate(s.me, id, kind, ciphertext), `/draft/sync/${encodeURIComponent(id)}/publish${w}`, 'sign_event');
}

/** nip07 continuation: signed wrap in -> publish it, re-render the status/row. */
export async function postDraftSyncPublish(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const id = ctx.params.id ?? '';
    const signed = await readSignedEvent(ctx.req);
    // Assert the draft-wrap kind (KIND_DRAFT/31234), not just the pubkey: without it the signer could
    // return any kind for us to publish. Best-effort re-render on mismatch (no bespoke error fragment).
    if (signed && signed.pubkey === s.me && signed.kind === KIND_DRAFT) {
        const ok = await publishDraftWrap(s, signed).catch(() => false);
        const cur = getDraft(s.me, id);
        if (ok && cur && cur.synced) saveDraft(s.me, { ...cur, syncedAt: cur.savedAt });
    }
    syncRerender(ctx, getDraft(s.me, id));
}

// nip07 decrypt-on-load chain state: chainId -> the wrap identifiers (order-matched to the
// decrypt batch we send), TTL'd so an abandoned chain self-evicts.
const draftChains = new Map<string, { ids: string[]; at: number }>();
const CHAIN_TTL = 2 * 60_000;
function newChain(ids: string[]): string {
    const now = Date.now();
    for (const [k, v] of draftChains) if (now - v.at > CHAIN_TTL) draftChains.delete(k);
    const chainId = randomBytes(9).toString('base64url');
    draftChains.set(chainId, { ids, at: now });
    return chainId;
}

/** nip07 GET /drafts/sync - fetch your wraps, batch-decrypt their contents via the extension. */
export async function getDraftsSync(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    if (!signsOnClient(s)) { sendFragment(ctx, draftsView(listDrafts(s.me), listScheduled(s.me).length > 0), PLACE_LIST); return; }
    const wraps = await fetchDraftWraps(s).catch(() => []);
    if (!wraps.length) { sendFragment(ctx, draftsView(listDrafts(s.me), listScheduled(s.me).length > 0), PLACE_LIST); return; }
    const chainId = newChain(wraps.map((w) => w.tags.find((t) => t[0] === 'd')?.[1] ?? ''));
    sendSignRequest(ctx, { items: wraps.map((w) => ({ pubkey: s.me, ciphertext: w.content })) }, `/drafts/sync/apply?chain=${chainId}`, 'nip44_decrypt_batch');
}

/** nip07 continuation: decrypted contents in -> merge into local, re-render the list. */
export async function postDraftsSyncApply(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const key = ctx.query.get('chain') ?? '';
    const chain = draftChains.get(key);
    draftChains.delete(key);
    const results = await readBatchResults(ctx.req);
    if (chain && results) {
        const synced: Draft[] = [];
        results.forEach((r, i) => {
            const id = chain.ids[i];
            if (r.ok && id && typeof r.value === 'string') {
                const d = draftFromDecrypted(r.value, id);
                if (d) synced.push(d);
            }
        });
        mergeSynced(s.me, synced);
    }
    sendFragment(ctx, draftsView(listDrafts(s.me), listScheduled(s.me).length > 0), PLACE_LIST);
}

/** POST /draft/delete/:id - remove a draft (swap the row out / reload zero-JS). */
/** Clear a draft after publish (or explicit delete): drop the local copy, and if it was synced,
 * retire its relay wrap. Bunker blanks the wrap inline; nip07 wrap-retirement is deferred (no
 * server-side key to sign the blank), so a nip07 wrap lingers until a manual un-sync. */
async function clearDraftAndWrap(s: Session & { me: string }, id: string): Promise<void> {
    const d = getDraft(s.me, id);
    deleteDraft(s.me, id);
    if (d?.synced && canSync(s)) { try { await unsyncDraft(s, id, draftToEvent(d, s.me).kind); } catch { /* best-effort */ } }
}

export async function postDraftDelete(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const id = ctx.params.id ?? '';
    const d = getDraft(s.me, id);
    // nip07 + synced: must retire the relay wrap (blank it) or it resurrects on the next /drafts
    // load. Can't sign server-side, so chain a sign-blank, then delete in the continuation.
    if (d?.synced && !canSync(s) && ctx.isPartial) {
        const kind = draftToEvent(d, s.me).kind;
        sendSignRequest(ctx, draftWrapTemplate(s.me, id, kind, ''), `/draft/delete/${encodeURIComponent(id)}/finish`, 'sign_event');
        return;
    }
    await clearDraftAndWrap(s, id); // bunker (inline blank) / unsynced / no-JS best-effort
    if (ctx.isPartial) sendFragment(ctx, html``);
    else redirect(ctx, '/drafts');
}

/** nip07 continuation: signed blank wrap in -> publish it (retire the relay copy), drop local. */
export async function postDraftDeleteFinish(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const id = ctx.params.id ?? '';
    const signed = await readSignedEvent(ctx.req);
    // Assert the draft-wrap kind (KIND_DRAFT/31234), not just the pubkey, before publishing the blank.
    if (signed && signed.pubkey === s.me && signed.kind === KIND_DRAFT) await publishDraftWrap(s, signed).catch(() => false);
    deleteDraft(s.me, id);
    sendFragment(ctx, html``, PLACE_ROW(id)); // swap the row out
}

/** nip07 continuation for a SYNCED article: the batch [signed article, signed blank wrap] comes
 * back; publish the article, retire the draft wrap, drop the local draft, land on the reader. */
async function articlePublishRetire(ctx: Ctx, s: Session & { me: string }): Promise<void> {
    const results = await readBatchResults(ctx.req);
    const article = results && results[0]?.ok ? verifySigned(results[0].value) : null;
    const landError = (error: string, status: number): void => {
        const c: ArticleComposeCtx = { ...fieldsFromSigned(article), error };
        sendFragment(ctx, page(articleComposePage(c), chromeFor(ctx, s, { active: 'compose', title: 'Article' })),
            { 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' }, status);
    };
    if (!article || article.pubkey !== s.me || article.kind !== KIND_ARTICLE) { landError("Couldn't verify the signed article.", 400); return; }
    try {
        await publishSigned(s.pool, { signed: article, isReply: false, writeTargets: s.myRelays?.write ?? [], inboxTargets: [] });
    } catch (err) { landError(`Couldn't publish: ${err instanceof Error ? err.message : String(err)}`, 502); return; }
    const wrap = results && results[1]?.ok ? verifySigned(results[1].value) : null; // the blank wrap (retire the draft)
    if (wrap && wrap.pubkey === s.me) await publishDraftWrap(s, wrap).catch(() => false);
    const d = article.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    deleteDraft(s.me, d);
    await ensureProfiles(s, [s.me]);
    const naddr = naddrOf(s, d);
    sendFragment(ctx, page(articleReader(article, s.profiles, s), chromeFor(ctx, s, { title: 'Article' })),
        { 'H-Push-Url': `/a/${naddr}`, 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' });
}

/** Reconstruct the composer fields from a signed kind-30023 (the nip07 continuation has no
 * form to read back), so a verify/publish error can re-render the composer without data loss. */
function fieldsFromSigned(ev: NostrEvent | null): ArticleComposeCtx {
    if (!ev || !Array.isArray(ev.tags)) return {};
    const tag = (k: string): string => ev.tags.find((t) => t[0] === k)?.[1] ?? '';
    return {
        identifier: tag('d') || undefined,
        title: tag('title'),
        summary: tag('summary'),
        image: tag('image'),
        topics: ev.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1]).join(', '),
        body: ev.content ?? '',
    };
}

/** nip07 continuation for a SCHEDULED article: verify the extension-signed 30023, hold it for the sweep,
 * and land on /drafts. The editable draft is kept (a scheduled post reverts to it on cancel). */
async function articleSchedule(ctx: Ctx, s: Session & { me: string }, schedule: number): Promise<void> {
    const signed = await readSignedEvent(ctx.req);
    const fail = (error: string, status: number): void =>
        sendFragment(ctx, page(articleComposePage({ ...fieldsFromSigned(signed as NostrEvent | null), error }), chromeFor(ctx, s, { active: 'compose', title: 'Article' })),
            { 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' }, status);
    if (!signed || signed.pubkey !== s.me || signed.kind !== KIND_ARTICLE) { fail("Couldn't verify the signed article.", 400); return; }
    if (!holdScheduled(s.me, signed as NostrEvent, schedule, s.myRelays?.write ?? [])) { fail(SCHEDULE_FULL_MSG, 400); return; }
    sendFragment(ctx, page(draftsScreen(listScheduled(s.me), listDrafts(s.me)), chromeFor(ctx, s, { active: 'drafts', title: 'Drafts' })),
        { 'H-Push-Url': '/drafts', 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' });
}

/** nip07 continuation: verify the extension-signed article, publish, land on it. */
export async function postArticlePublish(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const schedule = Number(ctx.query.get('schedule')) || 0;
    if (schedule > Math.floor(Date.now() / 1000)) { await articleSchedule(ctx, s, schedule); return; } // hold for the sweep
    if (ctx.query.get('retire')) { await articlePublishRetire(ctx, s); return; } // batched [article, blank wrap]
    const signed = await readSignedEvent(ctx.req);
    // The sign request set H-Reswap:none, so an error fragment with no retarget would nest the
    // whole composer inside the inline error box. Swap the body and re-render the composer with
    // the submitted fields (recovered from the signed event) so a failed publish loses nothing.
    const composerError = (error: string, status: number): void => {
        const c: ArticleComposeCtx = { ...fieldsFromSigned(signed), error };
        sendFragment(ctx, page(articleComposePage(c), chromeFor(ctx, s, { active: 'compose', title: 'Article' })),
            { 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' }, status);
    };
    if (!signed || signed.pubkey !== s.me || signed.kind !== KIND_ARTICLE) {
        composerError("Couldn't verify the signed article.", 400);
        return;
    }
    const writeTargets = s.myRelays?.write?.length ? s.myRelays.write : undefined;
    try {
        await publishSigned(s.pool, { signed: signed as NostrEvent, isReply: false, writeTargets: writeTargets ?? [], inboxTargets: [] });
    } catch (err) {
        composerError(`Couldn't publish: ${err instanceof Error ? err.message : String(err)}`, 502);
        return;
    }
    await ensureProfiles(s, [s.me]);
    const d = signed.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    await clearDraftAndWrap(s, d); // published → clear its draft (+ retire the wrap; nip07 lingers)
    const naddr = naddrOf(s, d);
    // Land on the new article (body swap + push the reader URL).
    sendFragment(ctx, page(articleReader(signed, s.profiles, s), chromeFor(ctx, s, { title: 'Article' })),
        { 'H-Push-Url': `/a/${naddr}`, 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' });
}
