// The kind-handler registry: the dispatch seam that turns Satori from hardcoded kind-switches into a
// manifest-driven (NATEOAS-shaped) app. Engine-tier - it knows NOTHING about any specific kind or about
// Satori's render code; the app registers handlers at boot (mirroring setPageRenderer in http.ts), and
// the render/route layers dispatch through `renderEvent` instead of branching on `ev.kind`.
//
// A handler owns three things, because that's what the code does per kind today:
//   - render(ev, surface, deps): the SAME kind renders differently per SURFACE (timeline / focused /
//     embed), exactly as noteCard vs focusedNote vs embedPreview do now.
//   - prepare(events, s): kind-specific PREFETCH (poll results for 1068, etc.) so routes stay generic.
//   - actions: the declared control vocabulary (ids), the seam where action templates slot in (Phase 4).
//
// Generic over a Deps type so the registry never imports render/ types (preserves the layering: the
// engine tier stays free of app render). Satori instantiates handlers with its own Deps shape.

import type { NostrEvent } from '../nostr/types.ts';
import type { SafeHtml } from '../html.ts';
import type { Session } from '../session.ts';

// timeline = feed/list row · focused = the anchor at the top of a thread · reader = a full-page view
// (the article reader) · embed = an inline quoted/referenced card.
export type Surface = 'timeline' | 'focused' | 'reader' | 'embed';

export interface KindHandler<D = unknown> {
    /** The event kinds this handler claims (e.g. [1, 1068] for notes+polls, [30023] for articles). */
    kinds: readonly number[];
    /** Render this event for a given surface. The SAME code Satori runs today, relocated not rewritten. */
    render(ev: NostrEvent, surface: Surface, deps: D): SafeHtml;
    /** Optional kind-specific prefetch for a page of events (keeps routes from hardcoding hydration). */
    prepare?(events: NostrEvent[], s: Session): Promise<void>;
    /** Declared action ids (the control vocabulary). Wired to templates in Phase 4. */
    actions?: readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous handlers share one table
type AnyHandler = KindHandler<any>;

const handlers = new Map<number, AnyHandler>();
let fallback: AnyHandler | null = null;

/** Register a handler for its kinds (app calls this at boot). Last registration for a kind wins. */
export function registerKind<D>(h: KindHandler<D>): void {
    for (const k of h.kinds) handlers.set(k, h as AnyHandler);
}

/** The handler for kinds with no registered handler (the unknown-kind path: njump-style today, a
 * declarative/manifest renderer later). This is the NATEOAS frontier - graceful, not a crash. */
export function registerFallback<D>(h: KindHandler<D>): void {
    fallback = h as AnyHandler;
}

export function handlerFor(kind: number): AnyHandler | undefined {
    return handlers.get(kind) ?? fallback ?? undefined;
}

export function hasHandler(kind: number): boolean {
    return handlers.has(kind);
}

/** Dispatch: render an event for a surface via its handler (or the fallback). Throws only if neither a
 * handler nor a fallback is registered - a boot wiring error, surfaced loudly rather than silently. */
export function renderEvent<D>(ev: NostrEvent, surface: Surface, deps: D): SafeHtml {
    const h = handlerFor(ev.kind);
    if (!h) throw new Error(`registry: no handler or fallback registered (kind ${ev.kind}, surface ${surface})`);
    return h.render(ev, surface, deps);
}
