// LITMUS (Phase 6): the NIP-68 "picture" kind (20), added entirely in the manifest layer. This file +
// its registration in satori.ts + one FEED_KINDS entry are the WHOLE change - no edits to render/note.ts,
// the feed route, or any core file (the only core touch anywhere was exporting the shared `noteActions`
// primitive, a generic building block). Proof the transform delivered: a new kind with its own layout
// is a manifest entry, not core surgery. Pictures put their image(s) in NIP-92 `imeta` tags (not the
// content), so the note fallback would show only the caption - this handler renders the images.

import type { KindHandler } from './registry.ts';
import { type SatoriDeps, notWired } from './deps.ts';
import { html, type SafeHtml } from '../html.ts';
import { avatar, displayName, npub, timeAgo } from '../render/util.ts';
import { imgSrc } from '../render/content.ts';
import { noteActions } from '../render/note.ts';
import { neventEncode } from 'nostr-tools/nip19';
import { KIND_PICTURE } from '../nostr/nip68.ts';
import type { NostrEvent } from '../nostr/types.ts';

/** Pull image url + alt out of each NIP-92 imeta tag (space-delimited "key value" sub-fields). */
function imetaImages(ev: NostrEvent): { url: string; alt: string }[] {
    const out: { url: string; alt: string }[] = [];
    for (const t of ev.tags) {
        if (t[0] !== 'imeta') continue;
        let url = '', alt = '';
        for (const part of t.slice(1)) {
            const sp = part.indexOf(' ');
            if (sp < 0) continue;
            const k = part.slice(0, sp);
            if (k === 'url') url = part.slice(sp + 1); else if (k === 'alt') alt = part.slice(sp + 1);
        }
        if (url) out.push({ url, alt });
    }
    return out;
}

/** A picture card in Satori's `.note` shell, image-forward. Reuses only EXPORTED primitives + existing
 * styled classes (.note/.media/.content), so no core render or CSS change is needed. `compact` (embed)
 * drops the action row. Images route through imgSrc = the SSRF-guarded, Tor-aware /media proxy. */
function pictureCard(ev: NostrEvent, d: SatoriDeps, compact: boolean): SafeHtml {
    const { profiles, s } = d;
    const nevent = neventEncode({ id: ev.id });
    const title = ev.tags.find((t) => t[0] === 'title')?.[1] ?? '';
    const media = imetaImages(ev).map((im) =>
        html`<a class="media-link" href="${imgSrc(im.url)}" target="_blank" rel="noreferrer"><img class="media" src="${imgSrc(im.url)}" alt="${im.alt}" loading="lazy"></a>`);
    return html`
      <li class="note">
        <a href="/u/${npub(ev.pubkey)}" aria-label="author" h-scroll="top instant">${avatar(ev.pubkey, profiles?.get(ev.pubkey)?.picture)}</a>
        <div class="note-body">
          <div class="note-head">
            <a class="author" href="/u/${npub(ev.pubkey)}" h-scroll="top instant">${displayName(ev.pubkey, profiles)}</a>
            <a class="time time-thread" href="/t/${nevent}" aria-label="View thread" h-scroll="top instant">${timeAgo(ev.created_at)}</a>
          </div>
          ${title ? html`<div class="content"><strong>${title}</strong></div>` : null}
          <div>${media}</div>
          ${ev.content ? html`<div class="content">${ev.content}</div>` : null}
          ${compact ? null : noteActions(ev, nevent, s)}
        </div>
      </li>`;
}

export const pictureHandler: KindHandler<SatoriDeps> = {
    kinds: [KIND_PICTURE],
    actions: ['reply', 'quote', 'like', 'zap', 'bookmark'], // declared control vocabulary
    render(ev, surface, d) {
        if (surface === 'reader') return notWired(surface); // pictures have no reader page
        return pictureCard(ev, d, surface === 'embed');
    },
};
