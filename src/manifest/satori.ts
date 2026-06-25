// The LOCAL MANIFEST: Satori's bundled kind registrations. Each card-rendered kind is its own module
// (manifest/{note,poll,article,picture}.ts); this file wires them into the registry at boot (server.ts
// calls registerSatoriKinds, mirroring setPageRenderer) and provides the unknown-kind fallback. Render
// handlers stay code (relocated, not rewritten) so behavior is byte-identical; the registry makes
// DISPATCH manifest-driven, and adding a kind is a new module + one register call - no core edit.

import { registerKind, registerFallback } from './registry.ts';
import { noteHandler } from './note.ts';
import { pollHandler } from './poll.ts';
import { articleHandler } from './article.ts';
import { pictureHandler } from './picture.ts';
import { fallbackHandler } from './fallback.ts';

export function registerSatoriKinds(): void {
    registerKind(noteHandler);
    registerKind(pollHandler);
    registerKind(articleHandler);
    registerKind(pictureHandler);
    registerFallback(fallbackHandler);
}
