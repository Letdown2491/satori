// NIP-92 media metadata. Events carry `imeta` tags describing each media URL:
// ["imeta", "url https://…", "alt a cat", "dim 800x600", "thumb https://…", …].
// We use alt (accessibility), dim (reserve space → no layout shift), and thumb/image
// (a preview frame, used as a proxied <video poster> so a video shows a frame without
// the browser fetching the video itself). Pure.

import type { NostrEvent } from './types.ts';

export interface MediaMeta { alt?: string; dim?: string; thumb?: string }
export type ImetaMap = Map<string, MediaMeta>;

/** Map each media URL in the event's imeta tags to its metadata. */
export function parseImeta(ev: NostrEvent): ImetaMap {
    const map: ImetaMap = new Map();
    for (const tag of ev.tags) {
        if (tag[0] !== 'imeta') continue;
        const meta: MediaMeta = {};
        let url = '';
        for (let i = 1; i < tag.length; i++) {
            const entry = tag[i];
            if (!entry) continue;
            const sp = entry.indexOf(' ');
            if (sp < 0) continue;
            const key = entry.slice(0, sp);
            const val = entry.slice(sp + 1).trim();
            if (key === 'url') url = val;
            else if (key === 'alt') meta.alt = val;
            else if (key === 'dim') meta.dim = val;
            // `thumb` is the dedicated video thumbnail; `image` is a preview - either works as a
            // poster. Prefer thumb; don't let a later `image` clobber a thumb.
            else if (key === 'thumb') meta.thumb = val;
            else if (key === 'image' && !meta.thumb) meta.thumb = val;
        }
        if (url) map.set(url, meta);
    }
    return map;
}
