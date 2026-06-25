// NATEOAS strawman engine - GENERIC. It knows NOTHING about any specific event kind.
// Given an event + a manifest (a render archetype with typed slots + control-templates), it renders
// the event and instantiates the manifest's actions. No Nostr: the "adapter" is a local-store write
// instead of a signed publish (that swap is the ONLY thing Nostr changes).
//
// Archetypes (the engine's ONLY opinion): card / reader / tile render a SINGLE event; `list` renders
// MANY by resolving references and recursing into each item's own manifest - which forces an Env
// (resolver + manifest registry). That env is exactly where "information architecture" logic lives.

export interface NEvent {
    id: string;
    pubkey: string;
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
}

export type Binding =
    | { tag: string }          // the first matching tag's value (t[1])
    | { imeta: string }        // a sub-field of the NIP-92 imeta tag (e.g. 'url')
    | { field: keyof NEvent }  // a top-level event field
    | { coord: true }          // the addressable coordinate  kind:pubkey:<d>
    | { const: string };

export interface RenderField { label: string; value: Binding; format?: 'datetime' | 'text'; }

export type Render =
    | { layout: 'card'; title: Binding; fields?: RenderField[]; body?: Binding }
    | { layout: 'reader'; cover?: Binding; title: Binding; summary?: Binding; byline?: Binding; body: Binding }
    | { layout: 'tile'; media: Binding; caption?: Binding }
    | { layout: 'list'; title: Binding; refs: string[] }; // refs = tag names that hold references (e.g. ['a','e'])

export interface ManifestAction {
    id: string;
    label: string;
    template: { kind: number; tags: string[][]; content?: string };
    placement?: string;
}

export interface Manifest { kind: number; name: string; render: Render; actions: ManifestAction[]; }

// What a `list` archetype needs from the world: resolve a reference to an event, and find the manifest
// for an item's kind. The local demo backs these with a store + a manifest map; Nostr backs `resolve`
// with a relay fetch. Single-event archetypes ignore env entirely.
export interface Env {
    resolve(ref: string): NEvent | undefined;
    manifestFor(kind: number): Manifest | undefined;
}

const PRIVILEGED = new Set([0, 3, 5, 10000, 10001, 10002, 10003, 10050, 24242]);

const tagValue = (ev: NEvent, name: string): string => ev.tags.find((t) => t[0] === name)?.[1] ?? '';
export const coordOf = (ev: NEvent): string => `${ev.kind}:${ev.pubkey}:${tagValue(ev, 'd')}`;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c));

function imetaValue(ev: NEvent, key: string): string {
    const tag = ev.tags.find((t) => t[0] === 'imeta');
    if (!tag) return '';
    for (const part of tag.slice(1)) {
        const sp = part.indexOf(' ');
        if (sp > 0 && part.slice(0, sp) === key) return part.slice(sp + 1);
    }
    return '';
}

// SEAM: production routes image URLs through the SSRF-guarded, Tor-aware /media proxy. Prototype passes
// through so the local page renders. The manifest supplies a URL binding; the engine owns markup + fetch.
const mediaProxy = (url: string): string => url; // prod: '/media?u=' + encodeURIComponent(url)

export function resolveBinding(ev: NEvent, b: Binding): string {
    if ('tag' in b) return tagValue(ev, b.tag);
    if ('imeta' in b) return imetaValue(ev, b.imeta);
    if ('field' in b) return String(ev[b.field] ?? '');
    if ('coord' in b) return coordOf(ev);
    return b.const;
}

export function fmt(value: string, format?: string): string {
    if (format === 'datetime' && /^\d+$/.test(value)) return new Date(Number(value) * 1000).toLocaleString();
    return value;
}

function subst(ev: NEvent, s: string, gen: Record<string, string>): string {
    return s.replace(/\{([^}]+)\}/g, (_, key: string) => {
        if (key === 'event.id') return ev.id;
        if (key === 'event.pubkey') return ev.pubkey;
        if (key === 'event.kind') return String(ev.kind);
        if (key === 'event.content') return ev.content;
        if (key === 'event.coord') return coordOf(ev);
        if (key.startsWith('event.tag.')) return tagValue(ev, key.slice('event.tag.'.length));
        if (key.startsWith('gen.')) return gen[key.slice(4)] ?? '';
        return '';
    });
}

// --- render ------------------------------------------------------------------------------------
const fieldRow = (label: string, value: string): string =>
    `<div class="nf"><span class="nl">${esc(label)}</span><span class="nv">${esc(value)}</span></div>`;

const actionRow = (actions: ManifestAction[]): string =>
    `<div class="nrow">${actions.map((a) => `<button class="na" data-action="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>`;

// A one-line label for ANY archetype - the "compact / list-item surface" reduction. Each archetype
// must expose this, which is the per-surface rendering point (timeline/focused/embed) in miniature.
function summaryOf(ev: NEvent, m: Manifest): string {
    const r = m.render;
    const raw = (r.layout === 'tile' ? resolveBinding(ev, r.caption ?? r.media) || '(image)' : resolveBinding(ev, r.title) || '(untitled)').replace(/\s+/g, ' ').trim();
    return raw.length > 90 ? raw.slice(0, 88).trimEnd() + '…' : raw; // a compact label is bounded
}

function cardBody(ev: NEvent, r: Extract<Render, { layout: 'card' }>): string {
    const fields = (r.fields ?? [])
        .map((f) => ({ label: f.label, value: fmt(resolveBinding(ev, f.value), f.format) }))
        .filter((f) => f.value).map((f) => fieldRow(f.label, f.value)).join('\n  ');
    const body = r.body ? resolveBinding(ev, r.body) : '';
    return `<h2 class="nt">${esc(resolveBinding(ev, r.title)) || '(untitled)'}</h2>
  ${fields}
  ${body ? `<p class="nb">${esc(body)}</p>` : ''}`;
}

function readerBody(ev: NEvent, r: Extract<Render, { layout: 'reader' }>): string {
    const cover = r.cover ? resolveBinding(ev, r.cover) : '';
    const summary = r.summary ? resolveBinding(ev, r.summary) : '';
    const byline = r.byline ? resolveBinding(ev, r.byline) : '';
    const paras = resolveBinding(ev, r.body).split(/\n\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('\n  ');
    return `${cover ? `<img class="ncover" src="${esc(mediaProxy(cover))}" alt="">` : ''}
  <h1 class="nt">${esc(resolveBinding(ev, r.title)) || '(untitled)'}</h1>
  ${summary ? `<p class="nsummary">${esc(summary)}</p>` : ''}
  ${byline ? `<div class="nbyline">${esc(byline)}</div>` : ''}
  <div class="nbody">${paras}</div>`;
}

function tileBody(ev: NEvent, r: Extract<Render, { layout: 'tile' }>): string {
    const url = resolveBinding(ev, r.media);
    const caption = r.caption ? resolveBinding(ev, r.caption) : '';
    return `${url ? `<img class="nhero" src="${esc(mediaProxy(url))}" alt="">` : ''}
  ${caption ? `<p class="ncaption">${esc(caption)}</p>` : ''}`;
}

function listBody(ev: NEvent, r: Extract<Render, { layout: 'list' }>, env?: Env): string {
    const refs = ev.tags.filter((t) => r.refs.includes(t[0])).map((t) => t[1]).filter(Boolean);
    const items = refs.map((ref) => {
        const item = env?.resolve(ref);
        if (!item) return `<li class="nli nli-missing">unresolved ref: ${esc(ref)}</li>`;
        const im = env?.manifestFor(item.kind); // RECURSE: render each item via its OWN manifest (compact surface)
        const kindLabel = im ? im.name : `kind ${item.kind}`;
        const label = im ? summaryOf(item, im) : '(no manifest)'; // unknown-kind fallback
        return `<li class="nli"><span class="nli-kind">${esc(kindLabel)}</span> ${esc(label)}</li>`;
    });
    return `<h2 class="nt">${esc(resolveBinding(ev, r.title)) || '(untitled)'}</h2>
  <ul class="nlist">${items.join('\n  ')}</ul>`;
}

/** Render an event purely from its manifest, dispatching on the archetype. `env` is only used by the
 * `list` archetype (resolve refs + look up item manifests); single-event archetypes ignore it. */
export function render(ev: NEvent, m: Manifest, env?: Env): string {
    const head = `<div class="nkind">${esc(m.name)} · kind ${ev.kind}</div>`;
    const r = m.render;
    const body = r.layout === 'card' ? cardBody(ev, r)
        : r.layout === 'reader' ? readerBody(ev, r)
        : r.layout === 'tile' ? tileBody(ev, r)
        : listBody(ev, r, env);
    return `<article class="n-${r.layout}">
  ${head}
  ${body}
  ${actionRow(m.actions)}
</article>`;
}

/** Instantiate a manifest action's template against the source event, authored by `actor`. Returns the
 * concrete (unsigned) event the action would produce. Enforces the privileged-kind wall. */
export function instantiate(ev: NEvent, action: ManifestAction, actor: string, gen: Record<string, string> = {}): Omit<NEvent, 'id'> {
    if (PRIVILEGED.has(action.template.kind)) {
        throw new Error(`refused: a manifest may not auto-template privileged kind ${action.template.kind}`);
    }
    return {
        pubkey: actor,
        kind: action.template.kind,
        tags: action.template.tags.map((t) => t.map((v) => subst(ev, v, gen))),
        content: subst(ev, action.template.content ?? '', gen),
        created_at: Math.floor(Date.now() / 1000),
    };
}
