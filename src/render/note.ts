// Note / profile / article view fragments, in Satori's exact markup + class
// names so the ported Sumi-e CSS applies 1:1. The string port of the relevant
// pieces of Satori's ui/components.ts. MVP-era reads; the full stateful action
// bar (like/zap/bookmark) is wired in Phase 1 - here the row is presentational
// with the navigational actions (reply/quote → thread) live.

import { neventEncode, naddrEncode } from 'nostr-tools/nip19';
import { html, join, raw, safeUrl, type SafeHtml } from '../html.ts';
import { renderContent, renderMarkdown, mediaLightboxes, imgSrc, withEmoji, cleanTrackingParams, type MediaPrefs } from './content.ts';
import { parseImeta, type ImetaMap } from '../nostr/imeta.ts';
import { parseEmojiTags } from '../nostr/emoji30.ts';
import { tokenize } from '../nostr/content.ts';
import { npub, shortNpub, displayName, timeAgo, avatar, type ProfileMap } from './util.ts';
import { icon, enso } from './svg.ts';
import { quote } from './quotes.ts';
import { replyParent } from '../nostr/nip10.ts';
import { formatNip05 } from '../nostr/nip05.ts';
import { parseArticle, readingMinutes, KIND_ARTICLE } from '../nostr/nip23.ts';
import { renderEvent, actionsFor } from '../manifest/registry.ts';
import { bookmarkButton, pinButton, followButton, muteButton, muteAct, likeButton } from './actions.ts';
import { isZapped } from '../zaps.ts';
import { replyFaces } from '../replies.ts';
import { hasReplied, hasReposted, engageTarget } from '../engaged.ts';
import type { NostrEvent } from '../nostr/types.ts';
import type { Profile } from '../data/profiles.ts';
import type { Session } from '../session.ts';

function pic(pubkey: string, profiles?: ProfileMap): string | undefined {
    return profiles?.get(pubkey)?.picture;
}

/** NIP-36 content warning: the reason string, '' (tag with no reason), or null. */
function contentWarning(ev: NostrEvent): string | null {
    const t = ev.tags.find((x) => x[0] === 'content-warning');
    return t ? (t[1] ?? '') : null;
}

/** Blur the rendered content behind a tap-to-reveal overlay (zero-JS via a hidden
 * checkbox whose label is the overlay; checking reveals + stays, like Satori). */
function cwWrap(inner: SafeHtml, reason: string, evId: string): SafeHtml {
    const cwid = `cw-${evId}`;
    return html`
      <div class="cw">
        <input type="checkbox" class="cw-toggle" id="${raw(cwid)}">
        ${inner}
        <label class="cw-overlay" for="${raw(cwid)}">
          <span class="cw-reason">${reason ? `Content warning · ${reason}` : 'Content warning'}</span>
          <span class="cw-tap">tap to reveal</span>
        </label>
      </div>`;
}

/** Estimate whether a note's TEXT is tall enough to clamp (Satori measures pixel
 * height in JS at 400px; with no client JS we approximate from wrapped line count,
 * skipping bare media-URL lines so image/video notes stay fully visible). */
function isTallText(content: string): boolean {
    let lines = 0;
    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (line === '') { lines += 1; continue; }
        if (/^https?:\/\/\S+$/.test(line)) continue; // a bare media/link line - rendered separately
        lines += Math.ceil(line.length / 62); // ~62 chars/line at the feed's width
    }
    return lines > 16; // ~16 lines ≈ the ~340px clamp height
}

// A single landscape image wider than this ratio renders short enough to skip the
// compact embed clamp (no dead "Show more"); anything taller/multiple/video collapses.
const EMBED_WIDE_RATIO = 1.9;

/** Whether a quoted/replied preview's media is likely to overflow the 240px embed
 * clamp (so it should collapse with Show more). Galleries and videos always do; a
 * single image does unless its imeta dim says it's clearly wide-and-short. With no
 * dim we assume tall, since a full-width single image usually is. */
function hasTallMedia(ev: NostrEvent): boolean {
    const media = tokenize(ev.content).filter((t) => t.t === 'image' || t.t === 'video');
    if (media.length === 0) return false;
    if (media.length > 1) return true; // gallery
    const only = media[0]!;
    if (only.t === 'video') return true;
    const dim = parseImeta(ev).get(only.url)?.dim;
    const m = dim ? /^(\d+)x(\d+)$/.exec(dim) : null;
    if (!m) return true; // unknown dims → assume tall
    return Number(m[1]) / Number(m[2]) <= EMBED_WIDE_RATIO;
}

/** Clamp tall content behind a "Show more"/"Show less" toggle (zero-JS checkbox). */
function clampWrap(inner: SafeHtml, evId: string): SafeHtml {
    const id = `more-${evId}`;
    return html`
      <div class="clamp">
        <input type="checkbox" class="clamp-toggle" id="${raw(id)}">
        <div class="clamp-inner">${inner}</div>
        <label class="show-more" for="${raw(id)}"></label>
      </div>`;
}

/** Rendered note content: CW reveal if flagged, else a Show-more clamp if the text
 * is long (unless `clamp` is false - the focused thread note shows in full). */
function noteContent(ev: NostrEvent, profiles?: ProfileMap, clamp = true, media?: MediaPrefs, imeta?: ImetaMap): SafeHtml {
    const body = renderContent(ev.content, profiles, true, media, imeta, parseEmojiTags(ev));
    const cw = contentWarning(ev);
    if (cw !== null) return cwWrap(body, cw, ev.id);
    return clamp && isTallText(ev.content) ? clampWrap(body, ev.id) : body;
}

function authorName(pubkey: string, profiles?: ProfileMap): SafeHtml {
    const p = profiles?.get(pubkey);
    // The badge lives INSIDE .author (as in Satori's AuthorName) - so it sits right
    // after the name, not pushed to the timestamp by `.note-head .author { margin-right:auto }`.
    const badge = p?.nip05Verified ? html`<span class="badge" title="${formatNip05(p.nip05)} (verified)">✓</span>` : null;
    return html`<a class="author" href="/u/${npub(pubkey)}" h-get h-prefetch="hover" h-scroll="top instant">${withEmoji(displayName(pubkey, profiles), p?.emoji)}${badge}</a>`;
}

function neventFor(ev: NostrEvent): string {
    try { return neventEncode({ id: ev.id, author: ev.pubkey }); } catch { return ev.id; }
}

/** The "in reply to" card: a link to the parent's thread that lazily loads the
 * parent note's preview (helmjs h-trigger="intersect once" → /embed), matching Satori's
 * reply card. Zero-JS shows the label only (still links to the thread). */
function replyContext(ev: NostrEvent): SafeHtml | null {
    const parent = replyParent(ev);
    if (!parent) return null;
    let bech = parent.id;
    try { bech = neventEncode({ id: parent.id, relays: parent.relays.slice(0, 1) }); } catch { /* keep raw id */ }
    const id = `rc-${parent.id.slice(0, 16)}`;
    // A sized card that lazily loads the parent on intersect (h-trigger="load" does
    // NOT fire on a <div>/<span>). The label links to the thread zero-JS; /embed
    // swaps in the full parent preview (rendered content, not a wrapping <a>).
    return html`<div id="${id}" class="quote reply-context" h-get="/embed/${bech}?as=reply" h-trigger="intersect once" h-target="#${raw(id)}" h-swap="inner" h-push-url="false"><a class="quote-label" href="/t/${bech}" aria-label="View thread">↩ in reply to an earlier note${icon('thread')}</a></div>`;
}

/** A note preview swapped into an embed card. The card is NOT a wrapping <a>
 * (nested anchors break it); the label links to the thread, the head to the
 * author, and the body uses renderContent (embeds=false → one level deep). */
export function embedPreview(ev: NostrEvent, bech: string, profiles?: ProfileMap, label = '↩ in reply to'): SafeHtml {
    const badge = profiles?.get(ev.pubkey)?.nip05Verified ? html`<span class="badge">✓</span>` : null;
    // The embed loads lazily, so the outer note's clamp never sees its height -
    // clamp the preview's own body when the quoted/replied text is long.
    const body = renderContent(ev.content, profiles, false, undefined, undefined, parseEmojiTags(ev));
    const clamped = (isTallText(ev.content) || hasTallMedia(ev)) ? clampWrap(body, ev.id) : body;
    return html`<a class="quote-label" href="/t/${bech}" aria-label="View thread" h-scroll="top instant">${label}${icon('thread')}</a
        ><div class="quote-head"><a class="quote-author-link" href="/u/${npub(ev.pubkey)}" h-scroll="top instant">${avatar(ev.pubkey, pic(ev.pubkey, profiles), 'xs')}<span class="quote-author">${withEmoji(displayName(ev.pubkey, profiles), profiles?.get(ev.pubkey)?.emoji)}${badge}</span></a></div
        ><div class="quote-body">${clamped}</div>`;
}

/** An article preview for an naddr embed card - title + author + summary. */
export function articleEmbedPreview(ev: NostrEvent, naddr: string, profiles?: ProfileMap): SafeHtml {
    const a = parseArticle(ev);
    return html`<a class="article-embed" href="/a/${naddr}" h-scroll="top instant">
        <span class="quote-label">↗ article</span>
        ${a.image && safeUrl(a.image) !== '#' ? html`<img class="article-embed-cover" src="${imgSrc(a.image)}" alt="" loading="lazy">` : null}
        <span class="article-embed-title">${a.title}</span>
        <span class="article-embed-by">${displayName(ev.pubkey, profiles)}</span>
        ${a.summary ? html`<span class="article-embed-summary">${a.summary}</span>` : null}
      </a>`;
}

/** The label-only fallback (parent not found) - keeps the thread link. */
/** The label-only fallback when an embed target can't be loaded (still a link). */
export const embedFallback = (href: string, label: string): SafeHtml => html`<a class="quote-label" href="${href}">${label}</a>`;

/** Live compose preview (Satori's renderPreview): a timeline-style note - your avatar
 * + name + "now" + the rendered draft - with no action row. `content` is the published
 * assembly (text + media urls); `imeta` carries NIP-92 dims/alt. Mentions/quotes/media
 * render through the same pipeline as a real note, so it's a true what-you-get view. */
export function composePreview(me: string, content: string, imeta: string[][], profiles?: ProfileMap): SafeHtml {
    const imetaMap = parseImeta({ tags: imeta, content } as NostrEvent);
    // Force autoLoad in the preview - you always want to see your own attached media,
    // regardless of the feed's "load media" setting.
    const previewMedia: MediaPrefs = { autoLoad: true };
    return html`
      <div class="preview-label">Preview</div>
      <div class="note preview-note">
        ${avatar(me, pic(me, profiles))}
        <div class="note-body">
          <div class="note-head">${authorName(me, profiles)}<span class="time">now</span></div>
          ${renderContent(content, profiles, true, previewMedia, imetaMap)}
        </div>
      </div>`;
}

/** The note action row. Reply/quote navigate to the thread (zero-JS); bookmark
 * (+ pin on your own notes) are live stateful actions; like/zap are presentational
 * until Phase 4. Order matches Satori: reply · quote · [like · zap] · bookmark · [pin]. */
/** The zap action: a link opening the zap modal when the author has a lightning
 * address (NIP-57), else a dimmed "unavailable" glyph (Satori's behavior). */
function zapAct(ev: NostrEvent, s?: Session): SafeHtml {
    const canZap = !!s && !!s.profiles.get(ev.pubkey)?.lud16;
    if (canZap) return zapButton(ev.id, ev.pubkey, isZapped(s!, ev.id));
    return html`<span class="note-act zap unavailable" title="No lightning address" aria-disabled="true">${icon('zap')}</span>`;
}

/** The zap link, keyed by note id so a successful one-tap zap can OOB-swap it to
 * the active (zapped) state. `active` fills the bolt + adds .active (warn tint);
 * `oob` marks it for an out-of-band swap from the /zap/paid continuation. */
export function zapButton(noteId: string, recipient: string, active: boolean, oob = false): SafeHtml {
    return html`<a id="zap-${noteId}" class="note-act zap${active ? ' active' : ''}"${oob ? raw(' h-oob="true"') : raw('')} href="/zap?e=${noteId}&p=${recipient}" h-target="#modal" h-swap="inner" title="${active ? 'Zapped ⚡' : 'Zap'}" aria-label="Zap">${icon('zap', active)}</a>`;
}

/** The reply glyph's presence dot + its tooltip, from the same data. `cls`: '' (none), ' convo'
 * (has replies), ' convo convo-net' (a follow is in it - accent). `label` reflects BOTH your own
 * participation and others' (they compose). `show` is false where the convo is already visible
 * (focused note / article reader) - then no dot and just the plain action label. */
function replyPresence(key: string, replied: boolean, show: boolean, verb: 'reply' | 'comment' = 'reply'): { cls: string; label: string } {
    const f = show ? replyFaces(key) : null;
    const has = !!f && f.repliers.length > 0;
    const net = has && f!.hasFollow;
    const you = verb === 'comment' ? 'You commented' : 'You replied'; // articles use NIP-22 comments
    const label = replied && net ? `${you}, and people you know are too`
        : replied && has ? `${you}, and others are too`
        : replied ? you
        : net ? 'People you know are discussing'
        : has ? 'People are discussing'
        : verb === 'comment' ? 'Comment' : 'Reply';
    return { cls: !has ? '' : net ? ' convo convo-net' : ' convo', label };
}

/** The right-aligned "who's talking" avatar stack: up to 3 repliers (follows-first) + a numberless
 * "+" when there are more. PEOPLE, not a count. Links into the conversation. Empty when no replies
 * (or not hydrated). Faces use cached profiles (follows-first → usually cached; a colored hue circle
 * otherwise). */
function replyFacesEl(key: string, href: string, s?: Session): SafeHtml {
    if (!s) return html``;
    const f = replyFaces(key);
    if (!f || f.repliers.length === 0) return html``;
    const label = `${f.repliers.length}${f.more ? '+' : ''} replied`;
    return html`<a class="reply-faces" href="${href}" h-get h-prefetch="hover" h-scroll="top instant" title="${label}" aria-label="${label}">${f.repliers.map((pk) => avatar(pk, pic(pk, s.profiles), 'xs'))}${f.more ? html`<span class="reply-faces-more">+</span>` : null}</a>`;
}

/** A note's action vocabulary, in render order. Declared DATA (also exposed on the kind handler's
 * `actions`), so the row is assembled from this list - the seam where a manifest's declared actions
 * slot in. Each id maps to its button below; the list decides which appear and in what order. */
export const NOTE_ACTIONS = ['reply', 'quote', 'like', 'zap', 'bookmark', 'mute', 'pin'] as const;

export function noteActions(ev: NostrEvent, nevent: string, s?: Session, inThread?: string, faces = true, mute = false): SafeHtml {
    const mine = !!s && ev.pubkey === s.me;
    // In a thread, the reply carries the thread context so it appends back here
    // (optimistic reply) instead of landing on the feed.
    const replyHref = `/compose?reply=${nevent}${inThread ? `&inthread=${inThread}` : ''}`;
    const replied = !!s && hasReplied(s, engageTarget(ev));   // fill the glyph if you've replied
    const reposted = !!s && hasReposted(s, engageTarget(ev));  // …or reposted (kind:6 / quote)
    const { cls: convo, label } = replyPresence(ev.id, replied, faces); // dot + tooltip ("You replied" / "People are discussing" / …)
    // Each declared action → its button, or null when it doesn't apply here. Same markup + conditions
    // as before, just keyed; NOTE_ACTIONS drives the set + order. (.note-acts is flex, so the inline
    // whitespace the old template carried between buttons is irrelevant - identical layout.)
    const acts: Record<string, SafeHtml | null> = {
        reply: html`<a class="note-act reply ${replied ? 'engaged' : ''}${convo}" href="${replyHref}" h-target="#modal" h-swap="inner" h-focus="#compose-text" title="${label}" aria-label="${label}">${icon('reply', replied)}</a>`,
        quote: html`<a class="note-act quote-act ${reposted ? 'engaged' : ''}" href="/compose?quote=${nevent}" h-target="#modal" h-swap="inner" h-focus="#compose-text" title="Quote" aria-label="Quote">${icon('quote', reposted)}</a>`,
        like: !mine && s?.reactions ? likeButton(s, ev.id, ev.pubkey) : null,
        zap: !mine ? zapAct(ev, s) : null,
        bookmark: s ? bookmarkButton(s, ev.id) : null,
        mute: mute && s && !mine ? muteAct(s, ev.pubkey, ev.id) : null,
        pin: mine && s ? pinButton(s, ev.id) : null,
    };
    // The action set + order come from the kind's manifest declaration (actionsFor), so a kind
    // affords exactly what its handler declares; NOTE_ACTIONS is the fallback for an unregistered kind.
    const ids = actionsFor(ev.kind) ?? NOTE_ACTIONS;
    return html`
      <div class="note-actions">
        <div class="note-acts">${ids.map((id) => acts[id]).filter((x): x is SafeHtml => x !== null)}</div>
        ${faces ? replyFacesEl(ev.id, `/t/${nevent}`, s) : null}
      </div>`;
}

/** The article zap action: opens the zap modal keyed by the article's naddr (the
 * zap request carries an `a`-tag), or a dimmed glyph when the author has no lud16. */
function articleZapAct(ev: NostrEvent, naddr: string, s?: Session): SafeHtml {
    const canZap = !!s && !!s.profiles.get(ev.pubkey)?.lud16;
    if (canZap) return articleZapButton(naddr, ev.pubkey, isZapped(s!, naddr));
    return html`<span class="note-act zap unavailable" title="No lightning address" aria-disabled="true">${icon('zap')}</span>`;
}

/** The article zap link, keyed by the naddr so a one-tap zap can OOB-swap it to the
 * zapped state. Mirrors zapButton but routes through /zap?a= (addressable target). */
export function articleZapButton(naddr: string, recipient: string, active: boolean, oob = false): SafeHtml {
    return html`<a id="zap-${naddr}" class="note-act zap${active ? ' active' : ''}"${oob ? raw(' h-oob="true"') : raw('')} href="/zap?a=${naddr}&p=${recipient}" h-target="#modal" h-swap="inner" title="${active ? 'Zapped ⚡' : 'Zap'}" aria-label="Zap">${icon('zap', active)}</a>`;
}

/** The article action row (Satori's articleActions): reply · quote · [like · zap]
 * · bookmark · [pin], keyed by the article's naddr (like/zap/bookmark/pin → `a`-tag).
 * `onPage` (the full reader) jumps Reply to the comment box; a feed row opens the article. */
/** An article's action vocabulary, in render order (no mute - articles aren't muted from the row). */
export const ARTICLE_ACTIONS = ['reply', 'quote', 'like', 'zap', 'bookmark', 'pin'] as const;

function articleActions(ev: NostrEvent, naddr: string, s?: Session, onPage = false): SafeHtml {
    const mine = !!s && ev.pubkey === s.me;
    const replied = !!s && hasReplied(s, engageTarget(ev));
    const reposted = !!s && hasReposted(s, engageTarget(ev));
    // Reply = a NIP-22 comment. On the article page the comment box is right here, so jump to it;
    // in a feed row there's no box, so open the article (where the box lives).
    const { cls: convo, label } = replyPresence(naddr, replied, !onPage, 'comment'); // articles → "comment" wording; no dot on the reader
    const acts: Record<string, SafeHtml | null> = {
        reply: onPage
            ? html`<a class="note-act reply ${replied ? 'engaged' : ''}" href="#comment-form" h-boost="false" title="${label}" aria-label="${label}">${icon('reply', replied)}</a>`
            : html`<a class="note-act reply ${replied ? 'engaged' : ''}${convo}" href="/a/${naddr}" h-scroll="top instant" title="${label}" aria-label="${label}">${icon('reply', replied)}</a>`,
        quote: html`<a class="note-act quote-act ${reposted ? 'engaged' : ''}" href="/compose?quote=${naddr}" h-target="#modal" h-swap="inner" h-focus="#compose-text" title="Quote" aria-label="Quote">${icon('quote', reposted)}</a>`,
        like: !mine && s?.reactions ? likeButton(s, naddr, ev.pubkey) : null,
        zap: !mine ? articleZapAct(ev, naddr, s) : null,
        bookmark: s && naddr ? bookmarkButton(s, naddr) : null,
        pin: mine && s && naddr ? pinButton(s, naddr) : null,
    };
    const ids = actionsFor(ev.kind) ?? ARTICLE_ACTIONS; // article's declared vocabulary (manifest-driven)
    return html`
      <div class="note-actions article-actions">
        <div class="note-acts">${ids.map((id) => acts[id]).filter((x): x is SafeHtml => x !== null)}</div>
        ${!onPage ? replyFacesEl(naddr, `/a/${naddr}`, s) : null}
      </div>`;
}

export interface NoteOpts {
    focused?: boolean;
    hideParent?: boolean;
    depth?: number;
    inThread?: string;                          // the thread's nevent → reply appends here
    pending?: { token: string; seconds: number }; // an optimistic (not-yet-published) reply
    mute?: boolean;                             // stranger-facing rows (notifications, Commons): add a mute glyph that dismisses the card
    isPrivate?: boolean;                         // a gift-wrapped private reply (NIP-59): badge it with a lock
}

/** The footer of a pending optimistic note: countdown + Undo (the whole note removes
 * itself on Undo). Replaces the action row until the note is confirmed/published. */
function pendingFooter(token: string, seconds: number): SafeHtml {
    const t = encodeURIComponent(token);
    return html`<div class="post-pending"><span>Posting in ${String(seconds)}s…</span> <button type="button" class="toast-action" h-post="/note/undo?token=${t}" h-target="#opt-${raw(token)}" h-swap="outer">Undo</button></div>`;
}

/** Timeline entry point for ANY event: dispatch to the kind's handler via the manifest registry
 * (article → articleRow, every other kind → noteRow). Byte-identical to the old `if kind===ARTICLE`
 * branch, now manifest-driven so adding a kind is a registration, not an edit here. */
export function noteCard(ev: NostrEvent, profiles?: ProfileMap, s?: Session, opts: NoteOpts = {}): SafeHtml {
    return renderEvent(ev, 'timeline', { profiles, s, opts });
}

/** One note as a feed/thread <li>, in Satori's flex `.note` layout. `depth` indents nested replies
 * (with the thread line), matching the thread view. A `pending` note self-polls /note/tick (countdown
 * → confirm in place / undo). The note/poll timeline render - the registry's fallback handler. */
export function noteRow(ev: NostrEvent, profiles?: ProfileMap, s?: Session, opts: NoteOpts = {}, extra?: SafeHtml): SafeHtml {
    const nevent = neventFor(ev);
    const im = parseImeta(ev); // NIP-92 alt + dim for the note's media
    const p = opts.pending;
    const parent = (opts.hideParent || p) ? null : replyContext(ev);
    const depth = opts.depth ?? 0;
    const cls = `note${p ? ' pending' : ''}${depth > 0 ? ` reply-nested depth-${Math.min(depth, 4)}` : ''}`;
    const liExtra = p
        ? raw(` id="opt-${p.token}" h-get="/note/tick?token=${encodeURIComponent(p.token)}" h-trigger="every 1s" h-target="#opt-${p.token}" h-swap="outer" h-push-url="false"`)
        : opts.mute ? raw(` id="card-${ev.id}"`) : raw(''); // mute glyph dismisses this card by id (ev.id is verified 64-hex via SimplePool verifyEvent → raw()-safe)
    return html`
      <li class="${cls}"${liExtra}>
        <a href="/u/${npub(ev.pubkey)}" aria-label="author" h-scroll="top instant">${avatar(ev.pubkey, pic(ev.pubkey, profiles))}</a>
        <div class="note-body">
          <div class="note-head">
            ${authorName(ev.pubkey, profiles)}
            ${opts.isPrivate ? html`<span class="private-mark" title="Private reply - only you and the author can see it">${icon('lock')}<span class="sr-only">Private reply</span></span>` : null}
            ${p || opts.isPrivate ? html`<span class="time">${p ? html`now` : timeAgo(ev.created_at)}</span>` : html`<a class="time time-thread" href="/t/${nevent}" aria-label="View thread" h-get h-prefetch="hover" h-scroll="top instant">${timeAgo(ev.created_at)}${icon('thread')}</a>`}
          </div>
          ${parent}
          ${noteContent(ev, profiles, true, s?.media, im)}
          ${!p && extra ? extra : null}
          ${p ? pendingFooter(p.token, p.seconds) : noteActions(ev, nevent, s, opts.inThread, true, opts.mute)}
        </div>
      </li>${p ? html`` : mediaLightboxes(ev.content, s?.media?.autoLoad ?? true, im)}`;
}

/** An article preview card - the string port of Satori's fillArticleCard: a cover
 * (image or quiet ensō placeholder) atop a body of kicker · title · summary · meta.
 * `hideAuthor` drops the author from the meta (shown elsewhere), leaving the
 * reading time. The clickable card is an <a> here (Satori used a JS-onClick div). */
function articleCard(ev: NostrEvent, profiles: ProfileMap | undefined, hideAuthor: boolean): SafeHtml {
    const a = parseArticle(ev);
    let naddr = '';
    try { naddr = naddrEncode({ kind: KIND_ARTICLE, pubkey: ev.pubkey, identifier: a.identifier, relays: [] }); } catch { /* */ }
    const href = naddr ? `/a/${naddr}` : '#';
    const mins = `${readingMinutes(a.content)} min read`;
    const cover = a.image && safeUrl(a.image) !== '#'
        ? html`<img class="article-card-cover" src="${imgSrc(a.image)}" loading="lazy" alt="">`
        : html`<div class="article-card-cover cover-missing">${enso(30, true)}</div>`;
    return html`
      <a class="article-card" href="${href}">
        ${cover}
        <div class="article-card-body">
          <div class="article-card-kicker">↗ Article</div>
          <div class="article-card-title">${a.title}</div>
          ${a.summary ? html`<div class="article-card-summary">${a.summary}</div>` : null}
          <div class="article-card-meta">
            ${hideAuthor ? null : authorName(ev.pubkey, profiles)}
            <span>${hideAuthor ? mins : ` · ${mins}`}</span>
          </div>
        </div>
      </a>`;
}

/** The article's CANONICAL naddr (relays:[]) - the shared key for its like/zap state across the
 * render (action buttons), the engagement-cache like sync, and the zap-receipt hydration. */
export function naddrFor(ev: NostrEvent): string {
    try { return naddrEncode({ kind: KIND_ARTICLE, pubkey: ev.pubkey, identifier: parseArticle(ev).identifier, relays: [] }); } catch { return ''; }
}

/** An article as a feed row (Satori's ArticleRow): author head + card + actions. */
export function articleRow(ev: NostrEvent, profiles?: ProfileMap, s?: Session): SafeHtml {
    const a = parseArticle(ev);
    return html`
      <li class="note article-row">
        <a href="/u/${npub(ev.pubkey)}" aria-label="author" h-scroll="top instant">${avatar(ev.pubkey, pic(ev.pubkey, profiles))}</a>
        <div class="note-body">
          <div class="note-head">
            ${authorName(ev.pubkey, profiles)}
            <a class="time time-thread" href="/a/${naddrFor(ev)}" aria-label="Open article" h-scroll="top instant">${timeAgo(a.publishedAt)}${icon('thread')}</a>
          </div>
          ${articleCard(ev, profiles, true)}
          ${articleActions(ev, naddrFor(ev), s)}
        </div>
      </li>`;
}

/** The focused note in a thread - an <li class="note focused"> in the feed list
 * (matching Satori), full content + the action row. */
export function focusedNote(ev: NostrEvent, profiles?: ProfileMap, s?: Session, inThread?: string, extra?: SafeHtml): SafeHtml {
    const parent = replyContext(ev);
    const im = parseImeta(ev);
    return html`
      <li class="note focused">
        <a href="/u/${npub(ev.pubkey)}" aria-label="author" h-scroll="top instant">${avatar(ev.pubkey, pic(ev.pubkey, profiles))}</a>
        <div class="note-body">
          <div class="note-head">
            ${authorName(ev.pubkey, profiles)}
            <span class="time">${timeAgo(ev.created_at)}</span>
          </div>
          ${parent}
          ${noteContent(ev, profiles, false, s?.media, im)}
          ${extra ?? null}
          ${noteActions(ev, neventFor(ev), s, inThread, false)}
        </div>
      </li>${mediaLightboxes(ev.content, s?.media?.autoLoad ?? true, im)}`;
}

/** The "Pinned" strip atop a profile (NIP-51 kind:10001 - featured notes then
 * articles, in pin order). noteCard renders an article event as its article row. */
export function pinnedStrip(notes: NostrEvent[], articles: NostrEvent[], profiles?: ProfileMap, s?: Session): SafeHtml {
    if (notes.length === 0 && articles.length === 0) return html``;
    const items = [...notes, ...articles].map((ev) => noteCard(ev, profiles, s));
    return html`
      <div class="pinned-wrap">
        <div class="strip-label">Pinned</div>
        <ul class="feed">${join(items)}</ul>
      </div>`;
}

/** The horizontal "Articles" strip - this author's long-form (kind:30023). A
 * native scroll-snap row of compact cards (Satori's JS prev/next arrows dropped). */
export function articlesStrip(articles: NostrEvent[], profiles?: ProfileMap): SafeHtml {
    if (articles.length === 0) return html``;
    const cards = articles.map((ev) => articleCard(ev, profiles, true));
    return html`
      <div class="article-strip-wrap">
        <div class="strip-label">Articles</div>
        <div class="article-strip-scroll"><div class="article-strip">${join(cards)}</div></div>
      </div>`;
}

/** A profile header in Satori's exact structure: avatar + actions, name (with the
 * verified badge inside .author), nip05 + copy-npub meta, about. The action
 * buttons are presentational in Phase 0 - wired (follow/mute/edit) in Phase 1. */
export function profileHeader(pubkey: string, profile: Profile | undefined, profiles: ProfileMap | undefined, s: Session, isMe = false): SafeHtml {
    const map = profiles ?? (profile ? new Map([[pubkey, profile]]) : undefined);
    // Edit your own profile: a real link to /profile/edit (zero-JS full-page editor);
    // helmjs opens it as a modal (#modal). The kind:0 save refreshes this header.
    const actions = isMe
        ? html`<a class="edit-profile-btn" href="/profile/edit" h-get="/profile/edit" h-target="#modal" h-swap="inner">Edit profile</a>`
        : html`${followButton(s, pubkey)}${muteButton(s, pubkey)}`;
    // NIP-24: wide background banner (proxied via /media like all images) and a website
    // link (scheme-checked; bare domains get https). (No "bot" badge: a bot won't self-declare,
    // so the badge was theatre - removed.)
    const banner = profile?.banner && imgSrc(profile.banner) !== '#'
        ? html`<img class="profile-banner" src="${imgSrc(profile.banner)}" alt="" loading="lazy">` : null;
    const website = websiteLink(profile?.website);
    return html`
      <div class="profile-header${banner ? ' has-banner' : ''}" id="profile-header">
        ${banner}
        <div class="profile-top">
          ${avatar(pubkey, profile?.picture, 'lg')}
          <div class="profile-actions">${actions}</div>
        </div>
        <div class="profile-name">${authorName(pubkey, map)}</div>
        <div class="profile-meta">
          <div class="profile-nip05">${profile?.nip05Verified ? formatNip05(profile.nip05) : ''}</div>
          <span class="copy-npub">${shortNpub(pubkey)} ⧉</span>
        </div>
        ${website}
        ${profile?.about ? html`<div class="profile-about">${withEmoji(profile.about, profile.emoji)}</div>` : null}
      </div>`;
}

/** A profile's NIP-24 website as a safe external link, or null. Bare domains get
 * https://; the visible text drops the scheme + trailing slash for a clean look. */
function websiteLink(raw0?: string): SafeHtml | null {
    if (!raw0) return null;
    // Clean tracking params off the profile website too (same privacy stance as content links).
    const url = cleanTrackingParams(/^https?:\/\//i.test(raw0) ? raw0 : `https://${raw0}`);
    const href = safeUrl(url);
    if (href === '#') return null;
    const text = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return html`<a class="profile-website" href="${href}" target="_blank" rel="noopener noreferrer">${icon('globe')}${text}</a>`;
}

/** The article reader (NIP-23): cover, title, byline, rendered markdown body,
 * then the action bar - mirroring Satori's showArticle. */
export function articleReader(ev: NostrEvent, profiles?: ProfileMap, s?: Session): SafeHtml {
    const a = parseArticle(ev);
    // Only treat it as a cover (and dedupe a matching leading body image) when it'll
    // actually render - an unsafe URL falls through to safeUrl '#'.
    const coverUrl = a.image && safeUrl(a.image) !== '#' ? a.image : undefined;
    const cover = coverUrl ? html`<img class="article-cover" src="${imgSrc(coverUrl)}" alt="">` : null;
    return html`
      <article class="article">
        ${cover}
        <h1 class="article-title">${a.title}</h1>
        <div class="article-byline">
          <a href="/u/${npub(ev.pubkey)}" aria-label="author" h-scroll="top instant">${avatar(ev.pubkey, pic(ev.pubkey, profiles), 'sm')}</a>
          ${authorName(ev.pubkey, profiles)}
          <span class="article-byline-meta">· ${timeAgo(a.publishedAt)} · ${readingMinutes(a.content)} min read</span>
        </div>
        ${renderMarkdown(a.content, profiles, coverUrl)}
        ${articleActions(ev, naddrFor(ev), s, true)}
      </article>`;
}

/** A list of notes (feed / profile / thread replies). */
export function noteList(events: NostrEvent[], profiles?: ProfileMap, s?: Session, opts: NoteOpts = {}): SafeHtml {
    return join(events.map((ev) => noteCard(ev, profiles, s, opts)));
}

/** Infinite-scroll sentinel: a real "older →" link (zero-JS navigation) that
 * helmjs upgrades to intersect-once load, replacing itself (outer) with the next
 * page + a fresh sentinel. Shared by the feed and the profile timeline. */
export function pagerSentinel(href: string): SafeHtml {
    return html`
      <li class="pager" id="more">
        <a href="${href}" h-get h-target="#more" h-swap="outer" h-trigger="intersect once, click" h-indicator="#more" h-push-url="false"><span class="pager-label">older →</span><span class="pager-loading">settling…</span></a>
      </li>`;
}

/** The Following feed's "caught up" clearing (ported from the original Satori): a still ensō + line that
 * ENDS a reading batch - a feed with real ends, not an endless scroll. The new-since-last-visit set is
 * capped to one window, then this; each "Continue reading" loads exactly one more batch ending in another
 * clearing (a deliberate tap, never auto-scroll), so you choose to keep going - it never runs away.
 *  - `caughtUp`: show the reassuring "You're all caught up" line (you've seen everything new).
 *  - `markTs` (newest shown): arms an intersect that advances your last-visit high-water when this
 *    clearing scrolls into view - so reaching the end marks you caught up, not merely loading.
 *  - `more` (a `until` cursor): renders the click-only "Continue reading" that swaps in the next batch. */
export function feedClearing(opts: { caughtUp: boolean; markTs?: number; more?: number }): SafeHtml {
    const mark = opts.markTs ? raw(` h-get="/feed/seen?ts=${String(opts.markTs)}" h-trigger="intersect once" h-swap="none" h-push-url="false"`) : raw('');
    // The ensō trails as the closing seal (落款). When you're CAUGHT UP, the seal IS the quiet gateway to
    // the older backlog - an unlabeled, hover/touch-discovered gesture, so "rest" isn't undercut by a UI
    // button inviting a backlog scroll. It stays a real link (aria-label + keyboard focus). When there's
    // genuinely MORE NEW below, that gets a visible "Continue reading" invite instead (it SHOULD be found).
    const older = opts.caughtUp && opts.more !== undefined;
    const seal = older
        ? html`<a class="enso-link" href="/?b=1&until=${String(opts.more)}" h-get h-target="#feed-clearing" h-swap="outer" h-push-url="false" aria-label="See earlier posts" title="See earlier posts">${enso(40, true)}</a>`
        : enso(40, true);
    const cont = (!opts.caughtUp && opts.more !== undefined)
        ? html`<a class="see-earlier feed-continue" href="/?b=1&until=${String(opts.more)}" h-get h-target="#feed-clearing" h-swap="outer" h-push-url="false">Continue reading →</a>`
        : null;
    return html`<li class="empty caught-up" id="feed-clearing"${mark}><span>${quote('caughtUp')}</span>${opts.caughtUp ? html`<span class="empty-sub">You’re all caught up.</span>` : null}${seal}${cont}</li>`;
}
