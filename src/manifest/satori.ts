// The LOCAL MANIFEST: Satori's bundled kind registrations. Each card-rendered kind is its own module
// (manifest/{note,poll,article,picture}.ts); this file wires them into the registry at boot (server.ts
// calls registerSatoriKinds, mirroring setPageRenderer) and provides the unknown-kind fallback. Render
// handlers stay code (relocated, not rewritten) so behavior is byte-identical; the registry makes
// DISPATCH manifest-driven, and adding a kind is a new module + one register call - no core edit.

import { registerKind, registerFallback, type KindHandler } from './registry.ts';
import { type SatoriDeps, notWired } from './deps.ts';
import { noteRow, focusedNote, embedPreview, NOTE_ACTIONS } from '../render/note.ts';
import { noteHandler } from './note.ts';
import { pollHandler } from './poll.ts';
import { articleHandler } from './article.ts';
import { pictureHandler } from './picture.ts';

// Any kind with no registered handler renders as a note (timeline → noteRow, focused → focusedNote,
// embed → embedPreview) - exactly the old "everything that isn't an article is a note" catch-all. This
// is the unknown-kind path, the NATEOAS frontier: a generic note today, a declarative manifest later.
const fallbackHandler: KindHandler<SatoriDeps> = {
    kinds: [],
    actions: NOTE_ACTIONS,
    render(ev, surface, d) {
        if (surface === 'timeline') return noteRow(ev, d.profiles, d.s, d.opts);
        if (surface === 'focused') return focusedNote(ev, d.profiles, d.s, d.inThread);
        if (surface === 'embed') return embedPreview(ev, d.bech ?? '', d.profiles, d.label);
        return notWired(surface);
    },
};

export function registerSatoriKinds(): void {
    registerKind(noteHandler);
    registerKind(pollHandler);
    registerKind(articleHandler);
    registerKind(pictureHandler);
    registerFallback(fallbackHandler);
}
