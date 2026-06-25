// Server-side content rendering - the string-emitting port of Satori's
// ui/components.ts Content() and renderMarkdown(). Runs over the SAME pure
// tokenizer (nostr/content.ts) and markdown parser (nostr/markdown.ts), but emits
// escaped HTML via the `html` helper instead of DOM nodes. Every text run is
// escaped by construction; nostr entities become in-app links (mentions → /u/,
// quotes → /t/, articles → /a/). Media and links are scheme-checked.

import { tokenize } from '../nostr/content.ts';
import { parseBlocks, parseInline } from '../nostr/markdown.ts';
import { html, raw, join, safeUrl, type SafeHtml } from '../html.ts';
import { npub, displayName, shortHash, type ProfileMap } from './util.ts';
import { icon } from './svg.ts';
import { parseYouTube, youtubeWatchUrl } from '../data/youtube.ts';
import type { MediaMeta, ImetaMap } from '../nostr/imeta.ts';
import type { EmojiMap } from '../nostr/emoji30.ts';
import { refFor } from '../manifest/registry.ts';

const SHORTCODE = /:([a-zA-Z0-9_-]+):/g;

/** Render a plain-text run, turning `:shortcode:` into NIP-30 custom-emoji images
 * (from `emoji`, proxied via /media); unknown shortcodes stay literal text. All
 * non-emoji text is escaped by construction. Used for note/comment bodies and for
 * profile names/about. */
export function withEmoji(text: string, emoji?: EmojiMap): SafeHtml {
    if (!emoji) return html`${text}`;
    const out: SafeHtml[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    SHORTCODE.lastIndex = 0;
    while ((m = SHORTCODE.exec(text))) {
        const url = emoji[m[1]!];
        if (!url) continue; // not a declared emoji → leave the literal :code: in place
        if (m.index > last) out.push(html`${text.slice(last, m.index)}`);
        out.push(html`<img class="emoji" src="${imgSrc(url)}" alt="${m[0]}" title="${m[0]}" loading="lazy">`);
        last = m.index + m[0].length;
    }
    if (last === 0) return html`${text}`;
    if (last < text.length) out.push(html`${text.slice(last)}`);
    return join(out);
}

function extLink(url: string, label: string): SafeHtml {
    const href = safeUrl(url);
    if (href === '#') return html`${label}`; // unsafe scheme → inert text
    return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function mentionLink(pubkey: string, profiles?: ProfileMap): SafeHtml {
    return html`<a class="mention" href="/u/${npub(pubkey)}" h-scroll="top instant">@${withEmoji(displayName(pubkey, profiles), profiles?.get(pubkey)?.emoji)}</a>`;
}

/** Pubkeys mentioned (nostr:npub / nprofile) inside a content string, so a feed can
 * hydrate their profiles BEFORE render - otherwise a mention degrades to @npub1…
 * (mirrors Satori hydrate.ts collecting `.mention[data-pubkey]` to ensureProfiles). */
export function mentionPubkeys(text: string): string[] {
    const out: string[] = [];
    for (const tok of tokenize(text)) if (tok.t === 'mention') out.push(tok.pubkey);
    return out;
}

/** The src for a DISPLAYED image: routed through our /media proxy so the browser never
 * hits the third-party host (the daemon's fetch honors Privacy Mode). safeUrl-invalid
 * → '#'. Video is not proxied yet (needs Range/streaming), so it stays direct. */
export function imgSrc(url: string): string {
    return safeUrl(url) === '#' ? '#' : `/media?u=${encodeURIComponent(url)}`;
}

function image(url: string): SafeHtml {
    if (safeUrl(url) === '#') return extLink(url, url);
    return html`<img class="media" src="${imgSrc(url)}" loading="lazy" alt="">`;
}

/** NIP-92 `dim` (WxH) → `width`/`height` HTML attributes, so the browser reserves the
 * slot's aspect-ratio before the media loads (no layout shift) with NO inline CSS - the
 * responsive `.media` rule (width:100%, height:auto) scales it. Empty when no usable dim. */
/** Parse an imeta `dim` ("800x600", tolerating decimals like "464.0x848.0" from some clients). */
function parseDim(dim?: string): { w: number; h: number } | null {
    const d = dim ? /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(dim) : null;
    return d ? { w: Math.round(+d[1]!), h: Math.round(+d[2]!) } : null;
}
function dimStyle(meta?: MediaMeta): SafeHtml {
    const d = parseDim(meta?.dim);
    return d ? raw(` width="${d.w}" height="${d.h}"`) : raw('');
}
/** Orientation bucket from the dim - a CSS class (no inline style) so a poster-less video
 * facade reserves roughly the right aspect; the real <video>'s width/height correct it on play. */
function aspectClass(dim?: string): string {
    const d = parseDim(dim);
    if (!d) return 'landscape';
    return d.w > d.h ? 'landscape' : d.w < d.h ? 'portrait' : 'square';
}

function video(url: string, meta?: MediaMeta): SafeHtml {
    const href = safeUrl(url);
    if (href === '#') return extLink(url, url);
    // With a poster (imeta thumb): show the frame; preload="none" so the video itself loads only
    // on play. Without one: a calm play-facade (no black box) that loads nothing until clicked.
    if (meta?.thumb) {
        return html`<video class="media ${aspectClass(meta.dim)}" src="${href}" controls preload="none" playsinline${dimStyle(meta)} poster="${imgSrc(meta.thumb)}"></video>`;
    }
    return videoFacade(url, meta);
}

/** No-poster play placeholder: a calm ink panel + play glyph (aspect-bucketed from the imeta
 * dim) that swaps in the autoplaying <video> on click. JS off: the link opens the file. */
function videoFacade(url: string, meta?: MediaMeta): SafeHtml {
    const href = safeUrl(url);
    if (href === '#') return extLink(url, url);
    const id = `vf-${mediaId(url)}`;
    const q = `u=${encodeURIComponent(url)}${meta?.dim ? `&dim=${encodeURIComponent(meta.dim)}` : ''}`;
    // The h-get lives on the <div> (helmjs reads h-get off non-anchors; on an <a> it would use
    // href and fetch the cross-origin mp4 itself → a connect-src block). The inner <a href=file>
    // is the no-JS fallback (opens the video directly); with JS the div swaps in the player.
    return html`<div class="video-facade ${aspectClass(meta?.dim)}" id="${raw(id)}" h-get="/video?${q}" h-target="#${raw(id)}" h-swap="outer" h-push-url="false"><a class="video-facade-play" href="${href}" aria-label="Play video">${icon('play', true)}</a></div>`;
}

/** The autoplaying player swapped in when a facade is clicked (explicit play). */
export function videoEmbed(url: string, dim?: string): SafeHtml {
    const href = safeUrl(url);
    if (href === '#') return extLink(url, url);
    return html`<video class="media ${aspectClass(dim)}" src="${href}" controls autoplay playsinline preload="auto"${dimStyle({ dim })}></video>`;
}

/** Appearance media prefs (from the settings cookie): whether to auto-load images/videos
 * at all. (Video autoplay was removed by design - calm by default, never auto-playing.) */
export interface MediaPrefs { autoLoad: boolean }
const DEFAULT_MEDIA: MediaPrefs = { autoLoad: true };

interface MediaItem { type: 'image' | 'video'; url: string; id: string; meta?: MediaMeta }

/** A stable per-URL id for the lightbox slide (the tile links to `#<id>`). Two
 * notes sharing an image collide harmlessly (both overlays would open). */
const mediaId = (url: string): string => `lb-${shortHash(url)}`;

/** Gather a run of adjacent media starting at `i` (absorbing whitespace-only text
 * between items); returns the run + the index just after it. Shared by renderContent
 * (inline tiles) and mediaRuns (the hoisted overlays), so their slide ids line up. */
function gatherRun(toks: ReturnType<typeof tokenize>, i: number, imeta?: ImetaMap): { run: MediaItem[]; next: number } {
    const run: MediaItem[] = [];
    let j = i;
    while (j < toks.length) {
        const t = toks[j]!;
        if (t.t === 'image' || t.t === 'video') { run.push({ type: t.t, url: t.url, id: mediaId(t.url), meta: imeta?.get(t.url) }); j++; }
        else if (t.t === 'text' && t.value.trim() === '') j++;
        else break;
    }
    return { run, next: j };
}

const playBadge = (): SafeHtml => html`<div class="gallery-play">${icon('play', true)}</div>`;

/** Where a media tile points: the in-app lightbox (`#id`, top-level notes) or the
 * raw file in a new tab (embed previews - their lightbox can't escape the note's
 * `content-visibility` containment, so we don't trap a broken overlay there). */
function tileHref(m: MediaItem, lightbox: boolean): { href: string; attrs: SafeHtml } {
    if (lightbox) return { href: `#${m.id}`, attrs: raw('') };
    const u = safeUrl(m.url);
    return { href: u, attrs: u === '#' ? raw('') : raw(' target="_blank" rel="noopener noreferrer"') };
}

/** A single image → opens the lightbox (its overlay is hoisted out of the note by
 * the caller via mediaLightboxes, so `position:fixed` escapes content-visibility). */
function singleImage(m: MediaItem, lightbox: boolean): SafeHtml {
    const href = safeUrl(m.url);
    if (href === '#') return extLink(m.url, m.url);
    const t = tileHref(m, lightbox);
    // aria-label gives the icon/image-only link an accessible name (WCAG H30); the img
    // stays alt="" (or its imeta alt) so it isn't announced twice.
    const label = m.meta?.alt || 'Open image';
    return html`<a class="media-link" href="${t.href}"${t.attrs} aria-label="${label}"><img class="media" src="${imgSrc(m.url)}" loading="lazy" alt="${m.meta?.alt ?? ''}"${dimStyle(m.meta)}></a>`;
}

/** 2+ adjacent media → a horizontal scroll-snap carousel; each tile opens the
 * lightbox at its index. Native swipe pages the strip; click-paging happens in the
 * (full-screen) lightbox. */
function gallery(run: MediaItem[], lightbox: boolean): SafeHtml {
    const tiles = run.map((m) => {
        // Video tiles show the proxied poster (a frame, no video fetch) when the imeta has one;
        // otherwise a neutral placeholder. Either way the tile is a link into the lightbox.
        const inner = m.type === 'video'
            ? (m.meta?.thumb
                ? html`<img class="gallery-media" src="${imgSrc(m.meta.thumb)}" loading="lazy" alt="${m.meta?.alt ?? ''}">`
                : html`<div class="gallery-media video-ph"></div>`) // ink placeholder (no fetch); tile links to lightbox
            : html`<img class="gallery-media" src="${imgSrc(m.url)}" loading="lazy" alt="${m.meta?.alt ?? ''}">`;
        const t = tileHref(m, lightbox);
        const label = m.meta?.alt || (m.type === 'video' ? 'Play video' : 'Open image');
        return html`<a class="gallery-tile" href="${t.href}"${t.attrs} aria-label="${label}">${inner}${m.type === 'video' ? playBadge() : null}</a>`;
    });
    return html`<div class="gallery-wrap"><div class="gallery">${join(tiles)}</div></div>`;
}

/** Group adjacent image/video tokens (absorbing whitespace-only separators) into
 * media runs, in document order - shared by renderContent (inline placement) and
 * mediaLightboxes (the hoisted overlays), so their slide ids line up. */
function mediaRuns(toks: ReturnType<typeof tokenize>, imeta?: ImetaMap): MediaItem[][] {
    const runs: MediaItem[][] = [];
    let i = 0;
    while (i < toks.length) {
        if (toks[i]!.t === 'image' || toks[i]!.t === 'video') {
            const { run, next } = gatherRun(toks, i, imeta);
            runs.push(run); i = next;
        } else i++;
    }
    return runs;
}

/** The full-screen lightbox overlays for a note's content. Rendered by noteCard
 * OUTSIDE the `<li>` (the `.note` has content-visibility → a containing block that
 * would trap a `position:fixed` overlay; Satori sidesteps this by mounting on
 * <body>). Single videos play inline, so they get no overlay. */
export function mediaLightboxes(text: string, autoLoad = true, imeta?: ImetaMap): SafeHtml {
    if (!autoLoad) return html``; // media shown as links → no lightbox overlays
    const overlays = mediaRuns(tokenize(text), imeta)
        .filter((run) => !(run.length === 1 && run[0]!.type === 'video'))
        .map((run) => lightbox(run));
    if (!overlays.length) return html``;
    // Wrap in an <li> (display:contents, see CSS) so these hoisted overlays are VALID
    // children of the feed <ul> - a bare <div> under <ul> is invalid - while staying out
    // of the note's paint-containment (content-visibility), which would trap the fixed overlay.
    return html`<li class="lightbox-host">${join(overlays)}</li>`;
}

/** The full-screen viewer for a media run (one overlay, one slide per item).
 * Opened purely by `:target` (see CSS): the strip scroll-snaps to the targeted
 * slide; ‹ › are links to neighbour slides; the backdrop / ✕ are links to `#_`. */
function lightbox(run: MediaItem[]): SafeHtml {
    const slides = run.map((m, idx) => {
        const href = safeUrl(m.url);
        const media = m.type === 'video'
            ? html`<video class="lightbox-media" src="${href}" controls playsinline preload="none"${m.meta?.thumb ? html` poster="${imgSrc(m.meta.thumb)}"` : html``}></video>`
            : html`<img class="lightbox-media" src="${imgSrc(m.url)}" alt="${m.meta?.alt ?? ''}">`;
        const prev = idx > 0 ? html`<a class="lightbox-nav prev" href="#${raw(run[idx - 1]!.id)}" aria-label="Previous">‹</a>` : null;
        const next = idx < run.length - 1 ? html`<a class="lightbox-nav next" href="#${raw(run[idx + 1]!.id)}" aria-label="Next">›</a>` : null;
        return html`<div class="lightbox-slide" id="${raw(m.id)}"><a class="lightbox-backdrop" href="#_" aria-label="Close"></a>${media}${prev}${next}</div>`;
    });
    return html`<div class="lightbox"><div class="lightbox-strip">${join(slides)}</div><a class="lightbox-close" href="#_" aria-label="Close">✕</a></div>`;
}

/** A lazily-loaded embed card (helmjs intersect → /embed): the quoted note /
 * article renders inline. The chip inside is the zero-JS + loading fallback. */
function embedCard(bech: string, as: string, label: string, href: string): SafeHtml {
    const id = `emb-${bech.slice(-14)}`;
    return html`<div class="quote embed-card" id="${id}" h-get="/embed/${bech}?as=${as}" h-trigger="intersect once" h-target="#${raw(id)}" h-swap="inner" h-push-url="false"><a class="quote-label" href="${href}">${label}</a></div>`;
}

/** A YouTube privacy-facade card (lazy, like embedCard). Hydrates into the proxied
 * thumbnail + title + a click-to-load nocookie player via /yt/card. Before that (and
 * with JS off) it's just a clean, tracking-free external link - so nothing contacts
 * Google until the card loads or the user clicks through. */
function youtubeCard(id: string, start?: number): SafeHtml {
    const t = start ? `?t=${start}` : '';
    return html`<div class="yt-card" id="yt-${id}" h-get="/yt/card/${id}${t}" h-trigger="intersect once" h-target="#yt-${id}" h-swap="inner" h-push-url="false"><a class="yt-fallback" href="${youtubeWatchUrl(id, start)}" target="_blank" rel="noopener noreferrer">▶ Watch on YouTube</a></div>`;
}

/** Render note content to safe HTML. nostr entities resolve to in-app links;
 * with `embeds` (default) a quoted note / article becomes a lazy inline card.
 * Pass `embeds=false` inside an embed preview to keep one level deep (chips). */
export function renderContent(text: string, profiles?: ProfileMap, embeds = true, media: MediaPrefs = DEFAULT_MEDIA, imeta?: ImetaMap, emoji?: EmojiMap): SafeHtml {
    const parts: SafeHtml[] = [];
    const toks = tokenize(text);
    let i = 0;
    // A token that renders as a BLOCK-level card (quoted note / article / media / YT facade).
    // The author's blank lines around such a card would otherwise render (.content is pre-wrap)
    // as a tall gap ON TOP of the card's own margin, so we trim newlines in the adjacent text.
    const isBlockEmbed = (t: typeof toks[number] | undefined): boolean => {
        if (!t) return false;
        if (t.t === 'image' || t.t === 'video') return true;
        if (t.t === 'quote') return embeds;
        if (t.t === 'address') return embeds && !!refFor(t.kind); // a kind with an in-app reference embeds as a block
        if (t.t === 'url') return embeds && media.autoLoad && !!parseYouTube(t.url);
        return false;
    };
    while (i < toks.length) {
        const tok = toks[i]!;
        // Media off (autoLoad=false) → each image/video is just a link, no fetch.
        if ((tok.t === 'image' || tok.t === 'video') && !media.autoLoad) {
            parts.push(extLink(tok.url, tok.url));
            i++;
            continue;
        }
        // Group a run of adjacent media (absorbing whitespace-only separators) →
        // a gallery (2+) or a single image / inline video. The lightbox OVERLAYS
        // are emitted separately (mediaLightboxes) so they can escape the note's
        // content-visibility containment; here we only place the tiles. In an embed
        // preview (embeds=false) tiles open the raw file (no in-note lightbox).
        if (tok.t === 'image' || tok.t === 'video') {
            const { run, next } = gatherRun(toks, i, imeta);
            if (run.length >= 2) parts.push(gallery(run, embeds));
            else if (run[0]!.type === 'video') parts.push(video(run[0]!.url, run[0]!.meta)); // single video plays inline
            else parts.push(singleImage(run[0]!, embeds));
            i = next;
            continue;
        }
        if (tok.t === 'text') {
            let v = tok.value;
            if (isBlockEmbed(toks[i - 1])) v = v.replace(/^[ \t]*\n[ \t\n]*/, ''); // drop blank line(s) after a card
            if (isBlockEmbed(toks[i + 1])) v = v.replace(/[ \t\n]*\n[ \t]*$/, ''); // drop blank line(s) before a card
            parts.push(withEmoji(v, emoji));
        }
        else if (tok.t === 'url') {
            // YouTube → a privacy facade card (top-level + media-on); otherwise (media
            // off, or inside an embed preview) still emit a CLEANED link (no si/utm).
            const yt = parseYouTube(tok.url);
            if (yt && embeds && media.autoLoad) parts.push(youtubeCard(yt.id, yt.start));
            else if (yt) { const w = youtubeWatchUrl(yt.id, yt.start); parts.push(extLink(w, w)); }
            else parts.push(extLink(tok.url, tok.url));
        }
        else if (tok.t === 'mention') parts.push(mentionLink(tok.pubkey, profiles));
        else if (tok.t === 'quote') {
            parts.push(embeds ? embedCard(tok.bech, 'quote', '↗ quoted note', `/t/${tok.bech}`)
                : html`<a class="mention" href="/t/${tok.bech}" h-scroll="top instant">↗ quoted note</a>`);
        } else if (tok.t === 'address') {
            const r = refFor(tok.kind); // the manifest decides how a reference to this addressable kind renders
            if (r) parts.push(embeds ? embedCard(tok.bech, r.as, r.label, r.path(tok.bech))
                : html`<a class="mention" href="${r.path(tok.bech)}" h-scroll="top instant">${r.label}</a>`);
            else parts.push(html`<a class="mention" href="https://njump.me/${tok.bech}" target="_blank" rel="noopener noreferrer">↗ event</a>`);
        } else {
            parts.push(html`<a class="mention" href="https://njump.me/${tok.bech}" target="_blank" rel="noopener noreferrer">↗ ${tok.type}</a>`);
        }
        i++;
    }
    return html`<div class="content">${join(parts)}</div>`;
}

// --- Markdown (NIP-23 article bodies) → safe HTML --------------------------

/** A plain-text run inside markdown: newlines → <br>, resolve urls/nostr entities. */
function inlineText(s: string, profiles?: ProfileMap): SafeHtml {
    const lines = s.split('\n');
    const out: SafeHtml[] = [];
    lines.forEach((line, i) => {
        if (i) out.push(raw('<br>'));
        if (line) out.push(inlineEntities(line, profiles));
    });
    return join(out);
}

/** Resolve urls / nostr entities in a markdown text fragment (no whitespace normalize). */
function inlineEntities(text: string, profiles?: ProfileMap): SafeHtml {
    const parts: SafeHtml[] = [];
    for (const tok of tokenize(text, false)) {
        if (tok.t === 'text') parts.push(html`${tok.value}`);
        else if (tok.t === 'url') { const yt = parseYouTube(tok.url); const w = yt ? youtubeWatchUrl(yt.id, yt.start) : tok.url; parts.push(extLink(w, w)); } // article body: clean the link (no card inline)
        else if (tok.t === 'image' || tok.t === 'video') parts.push(extLink(tok.url, tok.url));
        else if (tok.t === 'mention') parts.push(mentionLink(tok.pubkey, profiles));
        else if (tok.t === 'quote') parts.push(html`<a class="mention" href="/t/${tok.bech}" h-scroll="top instant">↗ note</a>`);
        else if (tok.t === 'address') { const r = refFor(tok.kind); parts.push(r
            ? html`<a class="mention" href="${r.path(tok.bech)}" h-scroll="top instant">${r.label}</a>`
            : html`<a class="mention" href="https://njump.me/${tok.bech}" target="_blank" rel="noopener noreferrer">↗ event</a>`); }
        else parts.push(html`<a class="mention" href="https://njump.me/${tok.bech}" target="_blank" rel="noopener noreferrer">↗ ${tok.type}</a>`);
    }
    return join(parts);
}

function renderInline(text: string, profiles?: ProfileMap): SafeHtml {
    const parts: SafeHtml[] = [];
    for (const tok of parseInline(text)) {
        if (tok.t === 'text') parts.push(inlineText(tok.v, profiles));
        else if (tok.t === 'strong') parts.push(html`<strong>${inlineEntities(tok.v, profiles)}</strong>`);
        else if (tok.t === 'em') parts.push(html`<em>${inlineEntities(tok.v, profiles)}</em>`);
        else if (tok.t === 'code') parts.push(html`<code class="md-code">${tok.v}</code>`);
        else if (tok.t === 'link') parts.push(extLink(tok.href, tok.text));
        else parts.push(image(tok.url));
    }
    return join(parts);
}

/** Render a Markdown article body to safe HTML (no innerHTML; everything escaped). */
export function renderMarkdown(md: string, profiles?: ProfileMap, coverUrl?: string): SafeHtml {
    const out: SafeHtml[] = [];
    const blocks = parseBlocks(md);
    // Drop a leading body image that duplicates the article's cover (the NIP-23 `image`
    // tag) - many authors put the hero in both, which would render it twice. Only the
    // FIRST block, exact-URL match → near-zero false positives. (Divergence from
    // Satori, which renders both; a deliberate reading-quality fix.)
    const start = coverUrl && blocks[0]?.t === 'image' && blocks[0].url === coverUrl ? 1 : 0;
    for (const b of blocks.slice(start)) {
        if (b.t === 'heading') {
            const level = Math.min(b.level + 1, 6);
            out.push(raw(`<h${level}>`));
            out.push(renderInline(b.text, profiles));
            out.push(raw(`</h${level}>`));
        } else if (b.t === 'paragraph') out.push(html`<p>${renderInline(b.text, profiles)}</p>`);
        else if (b.t === 'list') {
            const items = join(b.items.map((it) => html`<li>${renderInline(it, profiles)}</li>`));
            out.push(b.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
        } else if (b.t === 'quote') out.push(html`<blockquote>${renderInline(b.text, profiles)}</blockquote>`);
        else if (b.t === 'code') out.push(html`<pre class="md-pre"><code>${b.text}</code></pre>`);
        else if (b.t === 'hr') out.push(raw('<hr>'));
        else out.push(image(b.url));
    }
    return html`<div class="article-body">${join(out)}</div>`;
}
