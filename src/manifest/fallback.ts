// The UNKNOWN-KIND fallback: the NATEOAS frontier. A kind with no registered handler used to render
// AS A NOTE (author + content + reply/like/zap row) - a masquerade: it claimed Satori understood an
// event it doesn't. This renders an honest, calm card instead - it names the kind, shows the raw
// content if any, and offers "open in an app that supports this", with the handler DISCOVERED from
// the network via NIP-89 (kind:31990) rather than assumed. Graceful degradation extended to the
// manifest layer: Satori says what it can't do and points elsewhere, instead of faking it.

import { neventEncode } from 'nostr-tools/nip19';
import { html, join, safeUrl, type SafeHtml } from '../html.ts';
import { avatar, displayName, npub, shortNpub, timeAgo } from '../render/util.ts';
import { kindLabel, handlerUrl, type HandlerInfo } from '../nostr/nip89.ts';
import type { NostrEvent } from '../nostr/types.ts';
import { type SatoriDeps, notWired } from './deps.ts';
import type { KindHandler, Surface } from './registry.ts';

const RAW_CAP = 500; // unknown kinds may carry huge JSON in content; show a bounded, escaped preview

/** Best bech32 reference for this event: the entity the user referenced (embed/thread), else a
 * freshly-encoded nevent, else the raw id (njump still resolves it). */
function bechFor(ev: NostrEvent, d: SatoriDeps): string {
    if (d.bech) return d.bech;
    if (d.inThread) return d.inThread;
    try { return neventEncode({ id: ev.id, author: ev.pubkey }); } catch { return ev.id; }
}

/** njump opens any entity in a browser - the universal fallback when no NIP-89 handler is found. */
function njumpLink(bech: string): SafeHtml {
    return html`<a class="event-open-link njump" href="https://njump.me/${bech}" target="_blank" rel="noopener noreferrer">Open in njump ↗</a>`;
}

/** The discovery fragment (lazy /handlers response): NIP-89 web handlers as "Open in <app>" links,
 * then njump. Handler URLs are from STRANGERS' events, so each is safeUrl-gated (drop unsafe). */
export function handlerLinks(handlers: HandlerInfo[], bech: string, entity: string): SafeHtml {
    const links: SafeHtml[] = [];
    for (const h of handlers.slice(0, 4)) {
        const href = safeUrl(handlerUrl(h, bech, entity) ?? '');
        if (href === '#') continue; // unsafe scheme / no template - never trust a stranger's URL blindly
        links.push(html`<a class="event-open-link" href="${href}" target="_blank" rel="noopener noreferrer">Open in ${h.name || shortNpub(h.pubkey)} ↗</a>`);
    }
    links.push(njumpLink(bech));
    return join(links);
}

/** The lazy "open in" slot: njump shows immediately (always works); NIP-89-discovered handlers swap
 * in on intersect. Mirrors the poll-box / embed-card lazy-hydration pattern. */
function openInSlot(ev: NostrEvent, bech: string): SafeHtml {
    const id = `open-${ev.id.slice(0, 16)}`; // ev.id is hex → dom-safe
    return html`<div class="event-open" id="${id}" h-get="/handlers/${bech}?k=${String(ev.kind)}" h-trigger="intersect once" h-target="#${id}" h-swap="inner" h-push-url="false">${njumpLink(bech)}</div>`;
}

/** The honest unknown-event card. Embed = a compact quote-style card; timeline/focused = the note
 * shell MINUS the action row (reply/like/zap on an unknown kind is the masquerade we're removing). */
function unsupportedCard(ev: NostrEvent, surface: Surface, d: SatoriDeps): SafeHtml {
    const { profiles } = d;
    const bech = bechFor(ev, d);
    const label = kindLabel(ev.kind);
    const raw = ev.content?.trim();
    const preview = raw ? html`<div class="content event-raw">${raw.slice(0, RAW_CAP)}${raw.length > RAW_CAP ? '…' : ''}</div>` : null;

    if (surface === 'embed') {
        return html`<a class="quote-label" href="https://njump.me/${bech}" target="_blank" rel="noopener noreferrer">↗ ${label}</a
            ><div class="quote-head"><a class="quote-author-link" href="/u/${npub(ev.pubkey)}" h-scroll="top instant">${avatar(ev.pubkey, profiles?.get(ev.pubkey)?.picture, 'xs')}<span class="quote-author">${displayName(ev.pubkey, profiles)}</span></a></div
            ><div class="quote-body event-unsupported">Satori doesn't render this kind yet.</div>`;
    }
    return html`
      <li class="note">
        <a href="/u/${npub(ev.pubkey)}" aria-label="author" h-scroll="top instant">${avatar(ev.pubkey, profiles?.get(ev.pubkey)?.picture)}</a>
        <div class="note-body">
          <div class="note-head">
            <a class="author" href="/u/${npub(ev.pubkey)}" h-scroll="top instant">${displayName(ev.pubkey, profiles)}</a>
            <span class="time">${timeAgo(ev.created_at)}</span>
          </div>
          <div class="event-kind">Unsupported event · ${label}</div>
          ${preview}
          ${openInSlot(ev, bech)}
        </div>
      </li>`;
}

export const fallbackHandler: KindHandler<SatoriDeps> = {
    kinds: [],
    // No action vocabulary: reply/quote/like/zap on a kind Satori doesn't understand is the masquerade.
    render(ev, surface, d) {
        if (surface === 'timeline' || surface === 'focused' || surface === 'embed') return unsupportedCard(ev, surface, d);
        return notWired(surface);
    },
};
