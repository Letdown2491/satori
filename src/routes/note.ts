// Compose + publish a note (kind:1) - notes, replies, quotes, with an optional
// content warning. Two signing modes, both keeping the key off the server:
//   bunker - signNote builds + signs via the bunker, publishes, 303 → / (zero-JS).
//   nip07  - signNote runs with a *capture signer* (returns the template unsigned)
//            so the tags are built by the SAME code; the extension signs it and
//            POSTs to /note/publish, which verifies + publishes.
// Reuse over re-implementation: signNote owns the NIP-10 reply tags, NIP-18 quote
// tags, content-warning, mention p-tags, and relay-hint/inbox routing - both modes
// go through it, so there's one source of truth for note construction.

import { signNote, publishSigned, type Prepared, type ReplyTo, type QuoteRef } from '../data/publish.ts';
import { fetchRelayLists } from '../data/relays.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { decode } from 'nostr-tools/nip19';
import type { Signer } from '../data/signer.ts';
import type { NostrEvent, UnsignedEvent } from '../nostr/types.ts';
import { html, raw, type SafeHtml } from '../html.ts';
import { displayName } from '../render/util.ts';
import { icon } from '../render/svg.ts';
import { mediaItem, composeFileInput, undoToast } from '../render/compose.ts';
import { noteCard, composePreview } from '../render/note.ts';
import { remainingSeconds, cancelPublish, commitIfDue, getHeld, getCommitted } from '../undo.ts';
import { tryUndoWindow, sendReplyToThread } from './undo-window.ts';
import { articleComposePage, draftsScreen, type ArticleComposeCtx } from '../render/article-compose.ts';
import { getDraft, saveDraft, listDrafts, newDraftId, type NoteDraft, type PollDraft } from '../drafts.ts';
import { composeSyncEl } from './article.ts';
import { addScheduled, listScheduled } from '../data/scheduled.ts';
import { sendPrivateReply, syntheticReply } from '../data/dms.ts';
import { beginPrivateReplySend, sealStep, wrapPrivateReplyStep } from '../data/dms-nip07.ts';
import { page } from '../render/layout.ts';
import { requireLogin, chromeFor, ensureProfiles, LAND_ON_FEED } from './common.ts';
import { readSignedEvent } from '../nip07.ts';
import { readForm, redirect, sendPage, sendFragment, sendSignRequest, readBatchResults, type Ctx } from '../http.ts';
import { feedDocument } from './feed.ts';
import { pollComposeFields } from '../render/poll.ts';
import type { Session } from '../session.ts';
import { signsOnClient } from '../session.ts';

const MAX_INBOX_RELAYS = 4;

interface ComposeCtx { reply?: { nevent: string; name: string }; quote?: string; draft?: string; error?: string; isNew?: boolean; media?: string[][]; cw?: boolean; cwReason?: string; inThread?: string; draftId?: string; status?: string; syncEl?: SafeHtml }

/** The Note · Poll · Article segmented selector (only on new top-level posts,
 * matching Satori). Article (the long-form composer) is Phase 6. In a modal the
 * Note/Poll links re-load into #modal; on the page they navigate. */
function composeTypes(active: 'note' | 'poll', inModal = false): SafeHtml {
    const tgt = inModal ? raw(' h-target="#modal" h-swap="inner"') : raw('');
    // In the modal, focus the relevant field after the type-switch swap lands.
    const noteFocus = inModal ? raw(' h-focus="#compose-text"') : raw('');
    const pollFocus = inModal ? raw(' h-focus="#poll-question"') : raw('');
    return html`
      <div class="compose-types">
        <a class="compose-type ${active === 'note' ? 'active' : ''}" href="/compose"${tgt}${noteFocus}>Note</a>
        <a class="compose-type ${active === 'poll' ? 'active' : ''}" href="/compose?type=poll"${tgt}${pollFocus}>Poll</a>
        <a class="compose-type" href="/compose?type=article">Article</a>
      </div>`;
}

/** The note compose form body (reply-to + form + help) - no wrapper/selector.
 * ONE multipart form with two submit buttons: "Attach" overrides it to POST the
 * whole form (incl. the file) to /upload, "Publish" posts to /note. Both work
 * zero-JS (native `formaction`); helmjs honors the same submitter overrides
 * (`h-target="#media" h-swap="append"`) so Attach appends a thumbnail in place
 * while Publish boost-swaps. Keeping the file in the compose form is what lets a
 * zero-JS attach preserve the typed text + already-attached media on re-render. */
/** A `datetime-local` value (local tz) ~a minute out, for the schedule input's `min` (client-side
 * nudge against past times; the server validates for real). */
function minScheduleValue(): string {
    const p = (n: number) => String(n).padStart(2, '0');
    const d = new Date(Date.now() + 60_000);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function noteFormPart(c: ComposeCtx, inModal = false): SafeHtml {
    const title = c.reply ? 'Reply' : c.quote ? 'Quote' : null;
    return html`
      ${c.error ? html`<div class="notice error">${c.error}</div>` : null}
      ${c.reply ? html`<div class="reply-to">Replying to ${c.reply.name}</div>` : null}
      <!-- Default action is /upload so selecting a file auto-uploads (the form's
           change-from-#compose-attach trigger, bound to the stable label, not the
           OOB-reset file input). Publish overrides back to /note. -->
      <form class="compose-box" action="/upload" method="post" h-post enctype="multipart/form-data"
        h-trigger="submit, change from:#compose-attach" h-target="#media" h-swap="append">
        ${c.reply ? html`<input type="hidden" name="reply" value="${c.reply.nevent}">` : null}
        ${c.inThread ? html`<input type="hidden" name="inthread" value="${c.inThread}">` : null}
        ${c.quote ? html`<input type="hidden" name="quote" value="${c.quote}">` : null}
        ${c.draftId ? html`<input type="hidden" name="draftid" value="${c.draftId}">` : null}
        <textarea name="content" id="compose-text"
          aria-label="${c.quote ? 'Add a comment' : title ? 'Write a reply' : 'Write a note'}"
          h-get="/compose/suggest" h-trigger="input debounce:150" h-include="#compose-text" h-busy="false"
          h-selection="" h-target="#suggest" h-swap="inner" h-push-url="false" h-combobox="#suggest"
          placeholder="${c.quote ? 'Add a comment…' : title ? 'Write a reply…' : 'Write a note…'}">${c.draft ?? ''}</textarea>
        <div id="suggest" class="mention-box" role="listbox" aria-label="Suggestions"></div>
        <!-- CW is a foot icon toggle (the .cw-btn label flips this checkbox); the reason
             row reveals on :checked, pure CSS. The checkbox is also the submitted cw field. -->
        <input type="checkbox" id="cw-toggle" name="cw" value="1" class="cw-check"${c.cw ? raw(' checked') : raw('')}>
        <div class="cw-row"><input class="cw-reason-input" type="text" name="cw_reason" value="${c.cwReason ?? ''}" placeholder="Content warning reason (optional)" autocomplete="off"></div>
        <!-- Private reply (replies only): the .private-btn lock toggles this checkbox. When on it turns
             accent and reveals the caption; the form posts private=1 → a gift-wrapped reply, not a public one. -->
        ${c.reply ? html`<input type="checkbox" id="private-toggle" name="private" value="1" class="private-check">
        <div class="private-row">${icon('lock')}<span>Only ${c.reply.name === 'note' ? 'the author' : c.reply.name} can read this. It won't appear publicly.</span></div>` : null}
        <!-- Schedule (new notes only): the .schedule-btn clock toggles this checkbox; the row
             reveals on :checked (pure CSS, like CW). The "Schedule" button sends do=schedule. -->
        ${c.isNew ? html`<input type="checkbox" id="schedule-toggle" class="sched-check">
        <div class="schedule-row">
          <input class="schedule-input" type="datetime-local" name="schedule" min="${minScheduleValue()}" aria-label="Schedule for later">
          <button type="submit" class="ghost" name="do" value="schedule" formaction="/note" formmethod="post" h-target="body" h-swap="inner" title="Publish at this time (the daemon sends it even if your browser is closed)">Schedule</button>
        </div>` : null}
        <div class="compose-media" id="media">${(c.media ?? []).map((m) => mediaItem(m))}</div>
        <!-- Live preview (above the foot): listens to the textarea (debounced) + attached
             media, rendered through the real note pipeline. h-busy="false" so typing never
             trips the global loader; :empty hides it until there's something to show. -->
        <div id="compose-preview" class="compose-preview" h-get="/compose/preview"
          h-trigger="input from:#compose-text debounce:180, compose-media from:body" h-include="#compose-text, #media input[name=imeta]"
          h-target="#compose-preview" h-swap="inner" h-busy="false" h-push-url="false"></div>
        <div class="compose-foot">
          <label class="attach-btn" id="compose-attach" title="Add photo or video" aria-label="Add photo or video">${icon('image')}${composeFileInput()}</label>
          <label class="attach-btn cw-btn" for="cw-toggle" title="Content warning" aria-label="Content warning">${icon('alert')}</label>
          ${c.reply ? html`<label class="attach-btn private-btn" for="private-toggle" title="Reply privately - only the author can read it" aria-label="Reply privately">${icon('lock')}</label>` : null}
          ${c.isNew ? html`<label class="attach-btn schedule-btn" for="schedule-toggle" title="Schedule for later" aria-label="Schedule for later">${icon('clock')}</label>` : null}
          <!-- Zero-JS only: with JS the file auto-uploads on select, so this fallback
               button is hidden (noscript). It submits the form to its /upload action. -->
          <noscript><button type="submit" class="attach-go">Attach</button></noscript>
          <span class="compose-status">${c.status ?? ''}</span>
          ${c.syncEl ?? null}
          <!-- Save draft (new notes only): re-renders the composer in place with a saved status,
               not the feed. Replies/quotes are transient, so no draft there. -->
          ${c.isNew ? html`<button type="submit" class="ghost" formaction="/note/draft" formmethod="post" h-target="${inModal ? '#modal' : 'body'}" h-swap="inner">Save draft</button>` : null}
          <button type="submit" class="publish-btn" formaction="/note" formmethod="post" h-target="body" h-swap="inner">${title ?? 'Publish'}</button>
        </div>
      </form>`;
}

/** The poll compose form body (question + poll fields → POST /poll). */
function pollFormPart(d: PollDraft | null = null, inModal = false, status = '', syncEl?: SafeHtml): SafeHtml {
    return html`
      <form class="compose-box" action="/poll" method="post" h-post>
        ${d?.id ? html`<input type="hidden" name="draftid" value="${d.id}">` : null}
        <textarea name="content" id="poll-question" required placeholder="Ask a question…">${d?.question ?? ''}</textarea>
        ${pollComposeFields({ options: d?.options, multiple: d?.multi, duration: d?.duration })}
        <div class="compose-foot">
          <span class="compose-status">${status}</span>
          ${syncEl ?? null}
          <button type="submit" class="ghost" formaction="/poll/draft" formmethod="post" h-target="${inModal ? '#modal' : 'body'}" h-swap="inner">Save draft</button>
          <button type="submit" class="publish-btn" formaction="/poll" formmethod="post" h-target="body" h-swap="inner">Post poll</button>
        </div>
      </form>`;
}

/** Wrap compose body in Satori's modal overlay (the helmjs-enhanced presentation;
 * the /compose page is the zero-JS baseline). The ✕ clears #modal. Submitting the
 * form swaps the <body> (boosted) → the modal vanishes and the feed updates. */
function modalWrap(head: SafeHtml, body: SafeHtml): SafeHtml {
    return html`
      <div class="modal-overlay" id="compose-modal">
        <div class="modal">
          <div class="modal-head">${head}<button class="modal-close" h-get="/compose/close" h-target="#modal" h-swap="inner" h-push-url="false" title="Close" aria-label="Close">✕</button></div>
          ${body}
        </div>
      </div>`;
}

/** GET /compose/close - empties the modal mount (helmjs close). */
export function getComposeClose(ctx: Ctx): void {
    if (!requireLogin(ctx)) return;
    sendFragment(ctx, html``);
}

/** GET /compose/preview - a live render of the note being composed (debounced
 * textarea input + attached media), assembling the content exactly like /note does
 * (text + media urls). Empty draft → empty fragment, so the pane (:empty) stays
 * hidden. GET (read-only) on a <div>, since helm only honors h-get off a form;
 * h-busy="false" on the trigger keeps typing from flashing the loader. */
export function getComposePreview(ctx: Ctx): void {
    const s = requireLogin(ctx);
    if (!s) return;
    const text = (ctx.query.get('content') ?? '').trim();
    const imeta = ctx.query.getAll('imeta').map(parseImeta).filter((t): t is string[] => !!t);
    const mediaUrls = imeta.map((t) => t.find((x) => x.startsWith('url '))?.slice(4)).filter((u): u is string => !!u);
    const content = [text, ...mediaUrls].filter(Boolean).join('\n');
    if (!content) { sendFragment(ctx, html``); return; }
    sendFragment(ctx, composePreview(s.me, content, imeta, s.profiles));
}

/** Decode an nevent (or note1) into a reply target { id, pubkey }. */
function decodeReplyTo(nevent: string): ReplyTo | null {
    try {
        const d = decode(nevent);
        if (d.type === 'nevent') return { id: d.data.id, pubkey: d.data.author };
        if (d.type === 'note') return { id: d.data };
    } catch { /* */ }
    return null;
}

/** Decode an nevent/note (→ id) or naddr (→ article address) into a quote ref. */
function decodeQuote(entity: string): QuoteRef | null {
    try {
        const d = decode(entity);
        if (d.type === 'nevent') return { id: d.data.id, pubkey: d.data.author, relays: d.data.relays ?? [] };
        if (d.type === 'note') return { id: d.data };
        if (d.type === 'naddr') return { id: '', address: `${d.data.kind}:${d.data.pubkey}:${d.data.identifier}`, pubkey: d.data.pubkey, relays: d.data.relays ?? [] };
    } catch { /* */ }
    return null;
}

/** Parse a media item's hidden imeta input (JSON-encoded NIP-92 tag) back to an
 * array; reject anything that isn't a string[] led by "imeta". */
function parseImeta(v: string): string[] | null {
    try {
        const a = JSON.parse(v);
        return Array.isArray(a) && a[0] === 'imeta' && a.every((x) => typeof x === 'string') ? a as string[] : null;
    } catch { return null; }
}

/** Full-page compose (zero-JS baseline): selector (new) + form, in the view pad. */
function composePage(c: ComposeCtx): SafeHtml {
    return html`<div class="view-pad">${c.isNew ? composeTypes('note') : null}${noteFormPart(c)}</div>`;
}

/** Resolve a ComposeCtx from raw reply/quote nevents (+ carried fields), fetching
 * the reply author's name. Shared by the compose page and the zero-JS upload
 * re-render (so an attach with JS off keeps text/media/CW + the reply context). */
async function buildComposeCtx(
    s: Session & { me: string }, replyNevent: string | null, quoteNevent: string | null,
    extra: { draft?: string; media?: string[][]; cw?: boolean; cwReason?: string; error?: string } = {},
): Promise<ComposeCtx> {
    const c: ComposeCtx = { isNew: !replyNevent && !quoteNevent, ...extra };
    if (replyNevent) {
        const rt = decodeReplyTo(replyNevent);
        if (rt?.pubkey) await ensureProfiles(s, [rt.pubkey]);
        c.reply = { nevent: replyNevent, name: rt?.pubkey ? displayName(rt.pubkey, s.profiles) : 'note' };
    } else if (quoteNevent) {
        c.quote = quoteNevent;
    }
    return c;
}

/** Re-render the full /compose page (used by the zero-JS upload re-render). */
export async function respondComposePage(
    ctx: Ctx, s: Session & { me: string },
    opts: { reply?: string | null; quote?: string | null; draft?: string; media?: string[][]; cw?: boolean; cwReason?: string },
): Promise<void> {
    const c = await buildComposeCtx(s, opts.reply ?? null, opts.quote ?? null, opts);
    sendPage(ctx, composePage(c), chromeFor(ctx, s, { active: 'compose', title: c.reply ? 'Reply' : c.quote ? 'Quote' : 'Compose' }));
}

export async function getCompose(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const replyNevent = ctx.query.get('reply');
    const quoteNevent = ctx.query.get('quote');
    const isNew = !replyNevent && !quoteNevent;
    // helmjs opens compose as a modal overlay (#modal); zero-JS lands on the page.
    const inModal = ctx.isPartial && ctx.hTarget === '#modal';

    // A reopened draft (?draft=<id>): dispatch by its stored type.
    const draftId = isNew ? ctx.query.get('draft') : null;
    const draft = draftId ? getDraft(s.me, draftId) : null;

    if (isNew && (ctx.query.get('type') === 'poll' || draft?.type === 'poll')) {
        const pd = draft?.type === 'poll' ? draft : null;
        if (inModal) { sendFragment(ctx, modalWrap(composeTypes('poll', true), pollFormPart(pd, true))); return; }
        sendPage(ctx, html`<div class="view-pad">${composeTypes('poll')}${pollFormPart(pd)}</div>`, chromeFor(ctx, s, { active: 'compose', title: 'Poll' }));
        return;
    }

    // Article (NIP-23) is a full-page composer (never a modal), like Satori.
    if (isNew && (ctx.query.get('type') === 'article' || draft?.type === 'article')) {
        const d = draft?.type === 'article' ? draft : null;
        const c: ArticleComposeCtx = d ? { identifier: d.identifier, title: d.title, summary: d.summary, image: d.image, topics: d.topics, body: d.body } : {};
        sendPage(ctx, articleComposePage(c), chromeFor(ctx, s, { active: 'compose', title: 'Article' }));
        return;
    }

    const c: ComposeCtx = { isNew };
    if (draft?.type === 'note') {
        c.draft = draft.content; c.media = draft.imeta; c.cw = draft.cw; c.cwReason = draft.cwReason; c.draftId = draft.id;
    } else if (replyNevent) {
        const rt = decodeReplyTo(replyNevent);
        if (rt?.pubkey) await ensureProfiles(s, [rt.pubkey]);
        c.reply = { nevent: replyNevent, name: rt?.pubkey ? displayName(rt.pubkey, s.profiles) : 'note' };
        c.inThread = ctx.query.get('inthread') ?? undefined; // reply from a thread → append there
    } else if (quoteNevent) {
        c.quote = quoteNevent;
        c.draft = `\n\nnostr:${quoteNevent}`;
    }
    const title = c.reply ? 'Reply' : c.quote ? 'Quote' : 'Compose';

    if (inModal) {
        const head = isNew ? composeTypes('note', true) : html`<span>${title}</span>`;
        sendFragment(ctx, modalWrap(head, noteFormPart(c, true)));
        return;
    }
    sendPage(ctx, composePage(c), chromeFor(ctx, s, { active: 'compose', title }));
}

/** POST /note/draft - save the note composer as a LOCAL draft, then re-render the composer in
 * place with a saved status (modal stays open; zero-JS re-renders the page). New notes only. */
export async function postNoteDraft(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const form = await readForm(ctx.req, 30 * 1024 * 1024);
    const content = (form.get('content') ?? '').trim();
    const imeta = form.getAll('imeta').map(parseImeta).filter((t): t is string[] => !!t);
    const cw = form.get('cw') === '1';
    const cwReason = (form.get('cw_reason') ?? '').trim();
    const existingId = (form.get('draftid') ?? '').trim();
    const inModal = ctx.isPartial && ctx.hTarget === '#modal';
    const render = (c: ComposeCtx): void => {
        if (inModal) { sendFragment(ctx, modalWrap(composeTypes('note', true), noteFormPart(c, true))); return; }
        sendPage(ctx, composePage(c), chromeFor(ctx, s, { active: 'compose', title: 'Compose' }));
    };
    if (!content && imeta.length === 0) {
        render({ isNew: true, draftId: existingId || undefined, status: 'Nothing to save yet.' });
        return;
    }
    const id = existingId || newDraftId();
    const prev = getDraft(s.me, id);
    const draft: NoteDraft = { type: 'note', id, content, imeta, cw, cwReason, savedAt: Date.now(), synced: prev?.synced, syncedAt: prev?.syncedAt };
    saveDraft(s.me, draft);
    const syncEl = await composeSyncEl(s, draft); // auto-sync to relays (bunker inline; nip07 trigger)
    render({ isNew: true, draft: content, media: imeta, cw, cwReason, draftId: id, status: 'Draft saved ✓', syncEl });
}

/** POST /poll/draft - save the poll composer as a LOCAL draft, then re-render in place with a
 * saved status (modal stays open; zero-JS re-renders the page). */
export async function postPollDraft(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const form = await readForm(ctx.req);
    const question = (form.get('content') ?? '').trim();
    const options = form.getAll('option').map((o) => o.trim()).filter(Boolean);
    const multi = form.get('multiple') === '1';
    const duration = Number(form.get('duration') ?? '0') || 0;
    const id = (form.get('draftid') ?? '').trim() || newDraftId();
    const prev = getDraft(s.me, id);
    const draft: PollDraft = { type: 'poll', id, question, options, multi, duration, savedAt: Date.now(), synced: prev?.synced, syncedAt: prev?.syncedAt };
    const inModal = ctx.isPartial && ctx.hTarget === '#modal';
    const render = (status: string, syncEl?: SafeHtml): void => {
        if (inModal) { sendFragment(ctx, modalWrap(composeTypes('poll', true), pollFormPart(draft, true, status, syncEl))); return; }
        sendPage(ctx, html`<div class="view-pad">${composeTypes('poll')}${pollFormPart(draft, false, status, syncEl)}</div>`, chromeFor(ctx, s, { active: 'compose', title: 'Poll' }));
    };
    if (!question && options.length === 0) { render('Nothing to save yet.'); return; } // don't persist empty
    saveDraft(s.me, draft);
    const syncEl = await composeSyncEl(s, draft); // auto-sync to relays (bunker inline; nip07 trigger)
    render('Draft saved ✓', syncEl);
}

/** A no-op signer that returns the template unsigned, so signNote builds the exact
 * tags for the nip07 path (the extension does the real signing). */
const captureSigner = { signEvent: async (t: UnsignedEvent) => t as unknown as NostrEvent } as unknown as Signer;

export async function postNote(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    // Larger cap: the compose form is multipart and may still carry a selected (but
    // skipped) file if Publish is hit before the attach OOB reset lands.
    const form = await readForm(ctx.req, 30 * 1024 * 1024);
    const text = (form.get('content') ?? '').trim();
    const replyNevent = form.get('reply') || null;
    const inthread = (replyNevent && form.get('inthread')) || null; // reply from a thread
    const quoteNevent = form.get('quote') || null;
    const cw = form.get('cw') === '1';
    const cwReason = (form.get('cw_reason') ?? '').trim();
    const contentWarning = cw ? cwReason : null;
    // Uploaded media (Phase 3c): one NIP-92 imeta tag per item (hidden inputs filled
    // by /upload). The url lives in the imeta, so it's the single source of truth -
    // we append each url to the content (newline-joined, like Satori).
    const imeta = form.getAll('imeta').map(parseImeta).filter((t): t is string[] => !!t);
    const mediaUrls = imeta.map((t) => t.find((x) => x.startsWith('url '))?.slice(4)).filter((u): u is string => !!u);
    const content = [text, ...mediaUrls].filter(Boolean).join('\n');

    const back = (error: string, status = 400): void => {
        const c: ComposeCtx = { error, draft: text, isNew: !replyNevent && !quoteNevent, media: imeta, cw, cwReason };
        if (replyNevent) { const rt = decodeReplyTo(replyNevent); c.reply = { nevent: replyNevent, name: rt?.pubkey ? displayName(rt.pubkey, s.profiles) : 'note' }; }
        else if (quoteNevent) c.quote = quoteNevent;
        sendPage(ctx, composePage(c), chromeFor(ctx, s, { active: 'compose', title: c.reply ? 'Reply' : c.quote ? 'Quote' : 'Compose' }), status);
    };
    if (!content) { back('Write something or attach media first.'); return; }

    // Scheduling (top-level notes only): sign now with created_at = the scheduled time, hold it
    // on disk, and the daemon's sweep broadcasts it then. The "Schedule" button sends do=schedule.
    let scheduledAt = 0;
    if (!replyNevent && !quoteNevent && form.get('do') === 'schedule') {
        const t = new Date((form.get('schedule') ?? '').trim()).getTime();
        if (isNaN(t)) { back('Pick a time to schedule this for.'); return; }
        scheduledAt = Math.floor(t / 1000);
        if (scheduledAt <= Math.floor(Date.now() / 1000)) { back('Pick a time in the future to schedule.'); return; }
    }

    const opts = {
        content, contentWarning, imeta,
        replyTo: replyNevent ? decodeReplyTo(replyNevent) : null,
        quote: quoteNevent ? decodeQuote(quoteNevent) : null,
        ...(scheduledAt ? { createdAt: scheduledAt } : {}),
    };

    // Private reply (NIP-59 gift-wrapped): a reply only, delivered to the author's DM relays - never
    // published publicly. We build the EXACT NIP-10 tags via signNote+capture signer (so it threads and
    // renders like a public reply), then wrap instead of publish. Both signing families, parity with DMs.
    if (replyNevent && form.get('private') === '1') {
        const rt = decodeReplyTo(replyNevent);
        if (!rt?.pubkey || !rt.id) { back("Can't send a private reply without knowing the author."); return; }
        const tmpl = await signNote(captureSigner, s.pool, s.me, s.myRelays!, opts); // tags only; never signed/published
        const baseTags = tmpl.signed.tags;
        if (signsOnClient(s)) {
            const r = beginPrivateReplySend(s, rt.pubkey, rt.id, baseTags, content);
            if (!r) { back("Couldn't start the private reply."); return; }
            const q = new URLSearchParams({ reply: replyNevent, chain: r.chainId });
            if (inthread) q.set('inthread', inthread);
            sendSignRequest(ctx, { items: r.items }, `/note/private/seal?${q}`, 'nip44_encrypt_batch');
            return;
        }
        const pr = await sendPrivateReply(s, rt.pubkey, rt.id, baseTags, content);
        if (!pr) { back("Couldn't send the private reply.", 502); return; }
        if (inthread && ctx.isPartial) { sendReplyToThread(ctx, s, syntheticReply(pr), inthread, undefined, true); return; }
        redirect(ctx, `/t/${replyNevent}`);
        return;
    }

    // client-signs: build the exact template via signNote+capture signer, hand to the extension/app.
    if (signsOnClient(s)) {
        const prepared = await signNote(captureSigner, s.pool, s.me, s.myRelays!, opts);
        if (scheduledAt) { sendSignRequest(ctx, prepared.signed, `/note/publish?schedule=${scheduledAt}`); return; } // store, don't publish
        const q = new URLSearchParams();
        if (replyNevent) q.set('reply', replyNevent);
        if (inthread) q.set('inthread', inthread);
        sendSignRequest(ctx, prepared.signed, q.toString() ? `/note/publish?${q}` : '/note/publish');
        return;
    }

    // bunker: sign + publish here (signNote handles write + recipient-inbox routing).
    try {
        const prepared = await signNote(s.signer!, s.pool, s.me, s.myRelays!, opts);
        if (scheduledAt) { // hold the signed note for the sweep instead of publishing
            addScheduled({ token: newDraftId(), pubkey: s.me, signed: prepared.signed, scheduledAt, writeTargets: prepared.writeTargets });
            redirect(ctx, '/drafts');
            return;
        }
        if (await tryUndoWindow(ctx, s, prepared, true, inthread ?? undefined)) return; // hold + optimistic UI (helmjs)
        await publishSigned(s.pool, prepared);
        // Undo off but a thread reply (helmjs): append the confirmed reply in place.
        if (inthread && ctx.isPartial) { sendReplyToThread(ctx, s, prepared.signed, inthread); return; }
    } catch (err) {
        back(`Couldn't publish: ${err instanceof Error ? err.message : String(err)}`, 502);
        return;
    }
    redirect(ctx, '/'); // zero-JS; boosted fetch follows the 303 and swaps the feed
}

/** The replied-to author's inbox (read) relays, for reply delivery - mirrors
 * signNote's inbox routing, used by the nip07 continuation. */
async function replyInbox(s: Session & { me: string }, replyNevent: string): Promise<string[]> {
    const rt = decodeReplyTo(replyNevent);
    if (!rt?.pubkey) return [];
    const lists = await fetchRelayLists(s.pool, INDEXER_RELAYS, [rt.pubkey]).catch(() => new Map());
    const read = lists.get(rt.pubkey)?.read ?? [];
    return (read.length ? read : INDEXER_RELAYS).slice(0, MAX_INBOX_RELAYS);
}

/** POST /note/publish - the NIP-07 continuation: verify the extension-signed event
 * and publish (to write relays + recipient inbox for a reply), then land on the feed. */
export async function postNotePublish(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const signed = await readSignedEvent(ctx.req);
    if (!signed || signed.pubkey !== s.me || signed.kind !== 1) {
        sendFragment(ctx, html`<div class="notice error">Couldn't verify the signed note.</div>`, {}, 400);
        return;
    }

    // Scheduled (nip07): the extension signed our future-dated note; store it for the sweep.
    // Re-validate the client-supplied schedule time server-side: only hold it if it's actually in
    // the future. A tampered/stale value (past/0/NaN) just falls through to publish-now - the event's
    // created_at is already frozen by the signature, so this only governs broadcast timing.
    const schedule = Number(ctx.query.get('schedule')) || 0;
    if (schedule > Math.floor(Date.now() / 1000)) {
        const writeTargets = s.myRelays?.write?.length ? s.myRelays.write : INDEXER_RELAYS;
        addScheduled({ token: newDraftId(), pubkey: s.me, signed: signed as NostrEvent, scheduledAt: schedule, writeTargets });
        sendFragment(ctx, page(draftsScreen(listScheduled(s.me), listDrafts(s.me)), chromeFor(ctx, s as Session & { me: string }, { active: 'drafts', title: 'Drafts' })),
            { 'H-Push-Url': '/drafts', 'H-Retarget': 'body', 'H-Reselect': 'body', 'H-Reswap': 'inner' });
        return;
    }

    const replyNevent = ctx.query.get('reply');
    const inthread = (replyNevent && ctx.query.get('inthread')) || null;
    const writeTargets = s.myRelays?.write?.length ? s.myRelays.write : INDEXER_RELAYS;
    const inboxTargets = replyNevent ? await replyInbox(s, replyNevent) : [];
    const prepared: Prepared = { signed: signed as NostrEvent, isReply: !!replyNevent, writeTargets, inboxTargets };
    if (await tryUndoWindow(ctx, s as Session & { me: string }, prepared, false, inthread ?? undefined)) return; // nip07 = always JS
    try {
        await publishSigned(s.pool, prepared);
    } catch (err) {
        sendFragment(ctx, html`<div class="notice error">Couldn't publish: ${err instanceof Error ? err.message : String(err)}</div>`, {}, 502);
        return;
    }
    // Undo off but a thread reply: append the confirmed reply; else land on the feed.
    if (inthread) { sendReplyToThread(ctx, s as Session & { me: string }, prepared.signed, inthread); return; }
    sendFragment(ctx, await feedDocument(ctx, s as Session & { me: string }), LAND_ON_FEED);
}

/** Error fragment for a stalled private-reply send chain. Appended into the open thread (and the compose
 * modal closed) so it never wipes the page body the boosted form was targeting. */
function privateSendError(ctx: Ctx, msg: string): void {
    sendFragment(ctx, html`<li class="notice error">${msg}</li><div id="modal" h-oob="true"></div>`,
        { 'H-Retarget': '#thread', 'H-Reswap': 'append' }, 400);
}

/** POST /note/private/seal - nip07 continuation: encrypt results in, build the seal templates, sign-batch.
 * Mirrors the DM send chain but routed through the note composer (carries reply/inthread for the wrap). */
export async function postPrivateReplySeal(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return; if (!signsOnClient(s)) { privateSendError(ctx, 'Wrong signing mode.'); return; }
    const chainId = ctx.query.get('chain') ?? '';
    const results = await readBatchResults(ctx.req);
    const next = results ? sealStep(s, chainId, results) : null;
    if (!next) { privateSendError(ctx, "Couldn't send the private reply."); return; }
    const q = new URLSearchParams({ chain: chainId });
    const reply = ctx.query.get('reply'); if (reply) q.set('reply', reply);
    const inthread = ctx.query.get('inthread'); if (inthread) q.set('inthread', inthread);
    sendSignRequest(ctx, { templates: next.templates }, `/note/private/wrap?${q}`, 'sign_event_batch');
}

/** POST /note/private/wrap - nip07 continuation: signed seals in, wrap + publish to the author's DM
 * relays, then append the optimistic (lock-badged) reply in-thread, or redirect to the thread. */
export async function postPrivateReplyWrap(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return; if (!signsOnClient(s)) { privateSendError(ctx, 'Wrong signing mode.'); return; }
    const chainId = ctx.query.get('chain') ?? '';
    const results = await readBatchResults(ctx.req);
    const sent = results ? await wrapPrivateReplyStep(s, chainId, results) : null;
    if (!sent) { privateSendError(ctx, "Couldn't send the private reply."); return; }
    const reply = ctx.query.get('reply');
    const inthread = (reply && ctx.query.get('inthread')) || null;
    if (inthread) { sendReplyToThread(ctx, s as Session & { me: string }, syntheticReply(sent), inthread, undefined, true); return; }
    redirect(ctx, reply ? `/t/${reply}` : '/');
}

/** GET /note/tick?token= - the undo countdown poller. Each second it re-renders the
 * countdown (the bottom toast for a feed post, or the pending reply card in a
 * thread); at the deadline it publishes and reconciles in place (feed body-swap, or
 * the confirmed reply card); if the held event is gone (undone) it clears. */
export async function getNoteTick(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    if (!ctx.isPartial) { redirect(ctx, '/'); return; } // a full nav → just go to the feed
    const token = ctx.query.get('token') ?? '';
    const held = getHeld(token);
    const remaining = remainingSeconds(token);
    if (remaining === null || !held) {
        // Gone. If it COMMITTED (published) - not undone - the poll raced the deadline publish (or
        // the backstop committed first), so re-render the confirmed reply card instead of wiping
        // the optimistic note. Undone tokens (and feed posts, no reply) just clear.
        const c = getCommitted(token);
        if (c?.reply) { sendFragment(ctx, noteCard(c.signed, s.profiles, s, { hideParent: true, depth: 0, inThread: c.reply.inThread })); return; }
        sendFragment(ctx, html``);
        return;
    }
    const reply = held.reply;
    if (remaining > 0) { // counting down
        sendFragment(ctx, reply
            ? noteCard(held.prepared.signed, s.profiles, s, { hideParent: true, depth: 0, pending: { token, seconds: remaining } })
            : undoToast(token, remaining));
        return;
    }
    await commitIfDue(s.pool, token); // due → publish, then reconcile in place
    if (reply) { sendFragment(ctx, noteCard(held.prepared.signed, s.profiles, s, { hideParent: true, depth: 0, inThread: reply.inThread })); return; }
    sendFragment(ctx, await feedDocument(ctx, s), LAND_ON_FEED);
}

/** POST /note/undo?token= - cancel the held publish; remove the toast. */
export function postNoteUndo(ctx: Ctx): void {
    const s = requireLogin(ctx);
    if (!s) return;
    cancelPublish(ctx.query.get('token') ?? '');
    sendFragment(ctx, html``); // the undo button targets #undo-toast (outer) → removed
}
