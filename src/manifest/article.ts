// The long-form article kind (NIP-23 kind 30023). Renders the article card (timeline/feed row), the
// full reader page (/a/), the note-shaped thread anchor when reached via /t/ (matching Satori today),
// or the clean article preview when embedded. Render code is shared (render/note.ts); this is the handler.

import type { KindHandler } from './registry.ts';
import { type SatoriDeps, notWired } from './deps.ts';
import { articleRow, articleReader, focusedNote, articleEmbedPreview, ARTICLE_ACTIONS } from '../render/note.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';

export const articleHandler: KindHandler<SatoriDeps> = {
    kinds: [KIND_ARTICLE],
    actions: ARTICLE_ACTIONS,
    ref: { as: 'article', label: '↗ article', path: (bech) => `/a/${bech}` }, // inline naddr → the article reader

    render(ev, surface, d) {
        if (surface === 'timeline') return articleRow(ev, d.profiles, d.s);
        if (surface === 'reader') return articleReader(ev, d.profiles, d.s);
        // An article reached via /t/ (by nevent) renders as the note-shaped thread anchor, exactly as
        // getThread does today - it does NOT promote to the reader page. The /a/ route owns the reader.
        if (surface === 'focused') return focusedNote(ev, d.profiles, d.s, d.inThread);
        if (surface === 'embed') return articleEmbedPreview(ev, d.naddr ?? d.bech ?? '', d.profiles);
        return notWired(surface);
    },
};
