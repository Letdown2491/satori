// The Bookmarks (NIP-51 kind:10003) and Muted (kind:10000) views - public + PRIVATE
// (NIP-44-encrypted) items merged. Bunker decrypts server-side when the list loads.
// NIP-07 can't (no key here), so the page renders public items + a decrypt LOADER
// that does one nip44_decrypt round-trip via the extension, then re-renders with the
// private items in place - automatic on load, no toggle needed.

import { html, join, type SafeHtml } from '../html.ts';
import { emptyItem, enso } from '../render/svg.ts';
import { quote } from '../render/quotes.ts';
import { noteCard, naddrFor } from '../render/note.ts';
import { muteButton } from '../render/actions.ts';
import { avatar, npub, displayName } from '../render/util.ts';
import { withEmoji } from '../render/content.ts';
import { resolveListItems } from '../data/profile-extras.ts';
import { ensureLists, mutedPubkeys, listTags, privateReadable } from '../actions.ts';
import { ensureLikes } from '../likes.ts';
import { ensureEngaged, engageTarget } from '../engaged.ts';
import { ensureZaps } from '../zaps.ts';
import { ensureArticleReplies, replierPubkeys } from '../replies.ts';
import { INDEXER_RELAYS } from '../nostr/nip65.ts';
import { requireLogin, ensureProfiles, notePubkeys, chromeFor } from './common.ts';
import { readSignResult } from '../nip07.ts';
import { sendPage, sendFragment, sendSignRequest, redirect, notFound, type Ctx } from '../http.ts';
import type { Session } from '../session.ts';
import { signsOnClient } from '../session.ts';

const KIND_BOOKMARK = 10003;
const KIND_MUTE = 10000;
const isListKind = (k: number): boolean => k === KIND_BOOKMARK || k === KIND_MUTE;
const pageOf = (kind: number): string => (kind === KIND_MUTE ? '/muted' : '/bookmarks');
const place = (kind: number) => ({ 'H-Reswap': 'inner', 'H-Retarget': `#list-${kind}` });

/** A load-triggered decrypt of the list's private content (nip07): hits /list/<kind>
 * /decrypt → a nip44_decrypt sign-request → the continuation re-renders the list. */
function decryptLoader(kind: number): SafeHtml {
    return html`<li class="empty" h-get="/list/${kind}/decrypt" h-trigger="load" h-target="#list-${kind}" h-swap="inner" h-push-url="false">${enso(40, true)}<span>${quote('loading')}</span></li>`;
}

/** True while nip07 still needs to decrypt this list's private content (a key-bearing
 * round-trip). The whole list waits on it - otherwise the public items pop in first,
 * then jump when the private ones decrypt. */
function decryptPending(s: Session & { me: string }, kind: number): boolean {
    return signsOnClient(s) && !!s.lists.get(kind)?.content && !s.privateTags.has(kind);
}

/** A note when private items exist but can't be decrypted this session (failed/no key). */
function privacyBanner(s: Session & { me: string }, kind: number): SafeHtml | null {
    if (privateReadable(s, kind)) return null;
    return html`<li class="relay-empty">Your private items can’t be shown. This session can’t decrypt them.</li>`;
}

/** One muted user - avatar + name (→ profile) + an unmute toggle (optimistic). */
function muteRow(s: Session & { me: string }, pubkey: string): SafeHtml {
    const nip05 = s.profiles.get(pubkey)?.nip05;
    return html`
      <li class="mute-row">
        <a href="/u/${npub(pubkey)}" aria-label="profile" h-scroll="top instant">${avatar(pubkey, s.profiles.get(pubkey)?.picture, 'sm')}</a>
        <div class="mute-meta">
          <a class="mute-name" href="/u/${npub(pubkey)}" h-scroll="top instant">${withEmoji(displayName(pubkey, s.profiles), s.profiles.get(pubkey)?.emoji)}</a>
          ${nip05 ? html`<span class="mute-nip05">${nip05}</span>` : null}
        </div>
        ${muteButton(s, pubkey)}
      </li>`;
}

/** The inner rows of a list (banner + items), with profiles/likes hydrated. Shared
 * by the full-page render and the post-decrypt re-render. */
async function listInner(s: Session & { me: string }, kind: number): Promise<SafeHtml> {
    // Hold the whole list on the loader until private items decrypt (no partial list).
    if (decryptPending(s, kind)) return decryptLoader(kind);
    const banner = privacyBanner(s, kind);
    if (kind === KIND_MUTE) {
        const muted = [...mutedPubkeys(s)];
        await ensureProfiles(s, muted);
        if (!muted.length) return banner ?? emptyItem('You haven’t muted anyone.');
        // Count is rendered DOM-last (so the CSS counter sees every row) but shown on
        // top via flex order - it stays live as rows collapse on optimistic unmute.
        return html`${banner}${join(muted.map((pk) => muteRow(s, pk)))}<li class="list-count"><span class="count-n"></span> muted</li>`;
    }
    const relays = [...new Set([...(s.myRelays?.read ?? []), ...(s.myRelays?.write ?? []), ...INDEXER_RELAYS])];
    const { notes, articles } = await resolveListItems(s.pool, listTags(s, kind), relays);
    await Promise.all([
        ensureProfiles(s, [...notePubkeys(notes), ...articles.map((a) => a.pubkey)]),
        ensureLikes(s, notes.map((n) => n.id)),
        ensureEngaged(s, [...notes.map((n) => n.id), ...articles.map(engageTarget)]),
        ensureZaps(s), // one sync covers both the notes and the articles below
        ensureArticleReplies(s, articles.map(naddrFor)), // reply faces on the article rows
    ]);
    await ensureProfiles(s, replierPubkeys(articles.map(naddrFor))); // real avatars for the faces
    const items = [...notes, ...articles].sort((a, b) => b.created_at - a.created_at); // newest first
    if (!items.length) return banner ?? emptyItem('No bookmarks yet.');
    return html`<li class="list-count">${String(items.length)} bookmark${items.length === 1 ? '' : 's'}</li>${banner}${join(items.map((ev) => noteCard(ev, s.profiles, s)))}`;
}

/** GET /bookmarks - your saved notes + articles (public + private). */
export async function getBookmarks(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    await ensureLists(s, ['bookmark', 'pin', 'mute']); // list (+private, bunker) + action-bar state + mute filter
    sendPage(ctx, html`<ul class="feed" id="list-${KIND_BOOKMARK}">${await listInner(s, KIND_BOOKMARK)}</ul>`, chromeFor(ctx, s, { active: 'bookmarks', title: 'Bookmarks' }));
}

/** GET /muted - people you've muted (public + private), each with an unmute. */
export async function getMuted(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    await ensureLists(s, ['mute']);
    sendPage(ctx, html`<ul class="feed mute-list" id="list-${KIND_MUTE}">${await listInner(s, KIND_MUTE)}</ul>`, chromeFor(ctx, s, { active: 'muted', title: 'Muted' }));
}

/** GET /list/:kind/decrypt - return a nip44_decrypt sign-request for the list's
 * private content (nip07); the lib decrypts and POSTs the result to /decrypted. */
export async function getListDecrypt(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const kind = Number(ctx.params.kind);
    if (!isListKind(kind)) { notFound(ctx); return; }
    if (!ctx.isPartial) { redirect(ctx, pageOf(kind)); return; }
    await ensureLists(s, kind === KIND_BOOKMARK ? ['bookmark', 'pin', 'mute'] : ['mute']);
    const content = s.lists.get(kind)?.content;
    if (!content) { sendFragment(ctx, await listInner(s, kind), place(kind)); return; } // nothing private
    sendSignRequest(ctx, { pubkey: s.me, ciphertext: content }, `/list/${kind}/decrypted`, 'nip44_decrypt');
}

/** POST /list/:kind/decrypted - cache the decrypted private tags + re-render the
 * list. A failure caches `null` (so the loader won't retry - the note shows). */
export async function postListDecrypted(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const kind = Number(ctx.params.kind);
    if (!isListKind(kind)) { notFound(ctx); return; }
    await ensureLists(s, kind === KIND_BOOKMARK ? ['bookmark', 'pin', 'mute'] : ['mute']);
    let priv: string[][] | null = null;
    try { const j = JSON.parse(String(await readSignResult(ctx.req))); if (Array.isArray(j)) priv = j as string[][]; } catch { /* unreadable */ }
    s.privateTags.set(kind, priv);
    sendFragment(ctx, await listInner(s, kind), place(kind));
}
