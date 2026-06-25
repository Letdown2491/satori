// The LOCAL MANIFEST: Satori's bundled kind registrations. This is the app-tier "manifest" - it wraps
// Satori's existing render code as kind handlers and registers them with the engine-tier registry at
// boot (server.ts calls registerSatoriKinds, mirroring setPageRenderer). Per the plan, render handlers
// stay CODE (the same components, relocated not rewritten) so behavior is byte-identical; the registry
// only makes DISPATCH manifest-driven. Surfaces are wired one phase at a time:
//   Phase 1: embed   (this file) - article card vs note card, now dispatched not branched.
//   Phase 2: timeline, Phase 3: focused, Phase 4: declared action vocabulary.

import { registerKind, registerFallback, type KindHandler, type Surface } from './registry.ts';
import { embedPreview, articleEmbedPreview, articleRow, noteRow, focusedNote, articleReader, NOTE_ACTIONS, ARTICLE_ACTIONS, type NoteOpts } from '../render/note.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';
import { pictureHandler } from './picture.ts';
import type { ProfileMap } from '../render/util.ts';
import type { Session } from '../session.ts';

// Per-surface render inputs. Accretes as later phases wire more surfaces.
export interface SatoriDeps {
    profiles?: ProfileMap;
    s?: Session;       // timeline/focused/reader need the session (media prefs, signing mode, etc.)
    opts?: NoteOpts;   // timeline note-render options (pending, depth, mute, hideParent, inThread)
    inThread?: string; // focused: this thread's nevent, so reply buttons append back here
    bech?: string;   // embed: the embedded entity's bech32 (note/nevent/naddr) - link + lazy-load key
    naddr?: string;  // embed: an article's addressable form (article embed links via this)
    label?: string;  // embed: the note-embed label ("↗ quoted note" / "↩ in reply to")
}

const notWired = (surface: Surface): never => { throw new Error(`satori handler: surface '${surface}' not wired yet`); };

// Long-form articles: clean article card in the timeline, article preview when embedded.
const articleHandler: KindHandler<SatoriDeps> = {
    kinds: [KIND_ARTICLE],
    actions: ARTICLE_ACTIONS, // declared control vocabulary (the articleActions row consumes the same list)
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

// Everything else renders as a note: the `.note` card in the timeline (exactly the old noteCard body,
// now `noteRow`), a note preview when embedded. This is the catch-all the old code used (any non-article
// kind → note), and the unknown-kind path (the NATEOAS frontier): a generic note today, declarative later.
const fallbackHandler: KindHandler<SatoriDeps> = {
    kinds: [],
    actions: NOTE_ACTIONS, // the default action vocabulary (the noteActions row consumes the same list)
    render(ev, surface, d) {
        if (surface === 'timeline') return noteRow(ev, d.profiles, d.s, d.opts);
        if (surface === 'focused') return focusedNote(ev, d.profiles, d.s, d.inThread);
        if (surface === 'embed') return embedPreview(ev, d.bech ?? '', d.profiles, d.label);
        return notWired(surface); // reader is article-only (no /-route for other kinds)
    },
};

export function registerSatoriKinds(): void {
    registerKind(articleHandler);
    registerKind(pictureHandler); // Phase 6 litmus: NIP-68 picture (kind 20) - added purely in the manifest layer
    registerFallback(fallbackHandler);
}
