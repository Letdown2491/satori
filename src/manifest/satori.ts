// The LOCAL MANIFEST: Satori's bundled kind registrations. This is the app-tier "manifest" - it wraps
// Satori's existing render code as kind handlers and registers them with the engine-tier registry at
// boot (server.ts calls registerSatoriKinds, mirroring setPageRenderer). Per the plan, render handlers
// stay CODE (the same components, relocated not rewritten) so behavior is byte-identical; the registry
// only makes DISPATCH manifest-driven. Surfaces are wired one phase at a time:
//   Phase 1: embed   (this file) - article card vs note card, now dispatched not branched.
//   Phase 2: timeline, Phase 3: focused, Phase 4: declared action vocabulary.

import { registerKind, registerFallback, type KindHandler, type Surface } from './registry.ts';
import { embedPreview, articleEmbedPreview } from '../render/note.ts';
import { KIND_ARTICLE } from '../nostr/nip23.ts';
import type { ProfileMap } from '../render/util.ts';

// Per-surface render inputs. Accretes as later phases wire more surfaces; for Phase 1 only the embed
// fields are used (the bech/naddr identifier + the note-embed label).
export interface SatoriDeps {
    profiles?: ProfileMap;
    bech?: string;   // the embedded entity's bech32 (note/nevent/naddr) - the link + lazy-load key
    naddr?: string;  // an article's addressable form (article embed links via this)
    label?: string;  // note-embed label ("↗ quoted note" / "↩ in reply to")
}

const notWired = (surface: Surface): never => { throw new Error(`satori handler: surface '${surface}' not wired yet (Phase 1 is embed-only)`); };

// Long-form articles render as the clean article card.
const articleHandler: KindHandler<SatoriDeps> = {
    kinds: [KIND_ARTICLE],
    render(ev, surface, d) {
        if (surface === 'embed') return articleEmbedPreview(ev, d.naddr ?? d.bech ?? '', d.profiles);
        return notWired(surface);
    },
};

// Everything else embeds as a note card - exactly the old `else` branch in getEmbed, so a quoted note,
// poll, repost, or any non-article kind renders identically. This is the unknown-kind path (the NATEOAS
// frontier): today a generic note preview, a declarative/manifest renderer later.
const fallbackHandler: KindHandler<SatoriDeps> = {
    kinds: [],
    render(ev, surface, d) {
        if (surface === 'embed') return embedPreview(ev, d.bech ?? '', d.profiles, d.label);
        return notWired(surface);
    },
};

export function registerSatoriKinds(): void {
    registerKind(articleHandler);
    registerFallback(fallbackHandler);
}
