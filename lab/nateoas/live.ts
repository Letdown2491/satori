// NATEOAS strawman - LIVE DATA, THEMED AS SATORI. Same generic engine logic (engine.ts: binding
// resolution + archetype dispatch + manifests-as-data), but the markup here emits Satori's real class
// vocabulary and the page inlines Satori's actual public/styles.css. So the rendered output is styled
// identically to Satori - demonstrating that the THEME (class vocabulary + stylesheet) is the swappable
// layer, while the engine's logic and the manifests are unchanged. Run:  node lab/nateoas/live.ts
//
// Renders, for a real npub, whatever of {note, article, bookmark-list} it actually has.

import { SimplePool } from 'nostr-tools/pool';
import { decode } from 'nostr-tools/nip19';
import { type NEvent, type Manifest, type Env, type Render, resolveBinding, coordOf } from './engine.ts';
import { readFileSync, writeFileSync } from 'node:fs';

const NPUB = 'npub1m2jphmdkskgnvwl5gplksl9e0zwv2sldqf9mwlpz6tyymz84g9fsqr3wgu';
const pk = decode(NPUB).data as string;
const RELAYS = ['wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://nostr.wine', 'wss://relay.highlighter.com'];
const pool = new SimplePool();
const q = (filter: object): Promise<NEvent[]> =>
    Promise.race([pool.querySync(RELAYS, filter as never, { maxWait: 7000 }) as Promise<NEvent[]>, new Promise<NEvent[]>((r) => setTimeout(() => r([]), 9500))]);

// --- manifests (pure data; identical to the synthetic demo's) -----------------------------------
const react = (id: string, label: string, content: string) => ({ id, label, template: { kind: 7, tags: [['e', '{event.id}'], ['p', '{event.pubkey}'], ['k', '{event.kind}']], content } });
const noteManifest: Manifest = { kind: 1, name: 'Note', render: { layout: 'card', title: { field: 'content' } }, actions: [react('r', 'Reply', ''), react('q', 'Quote', ''), react('z', 'Zap', '')] };
const articleManifest: Manifest = { kind: 30023, name: 'Article', render: { layout: 'reader', cover: { tag: 'image' }, title: { tag: 'title' }, summary: { tag: 'summary' }, byline: { tag: '_author' }, body: { field: 'content' } }, actions: [react('r', 'Comment', ''), react('z', 'Zap', '')] };
const bookmarkManifest: Manifest = { kind: 10003, name: 'Bookmarks', render: { layout: 'list', title: { const: 'Bookmarks' }, refs: ['e', 'a'] }, actions: [] };
const byKind = new Map<number, Manifest>([[1, noteManifest], [30023, articleManifest], [10003, bookmarkManifest]]);

// A note body is RICH CONTENT (inline media), so prefer a note that actually has an image to show it.
const IMG = '(?:jpg|jpeg|png|gif|webp|avif)';
const hasImage = (ev: NEvent): boolean => new RegExp(`https?://\\S+\\.${IMG}`, 'i').test(ev.content) || ev.tags.some((t) => t[0] === 'imeta');

// --- fetch --------------------------------------------------------------------------------------
console.log('fetching real data for', NPUB.slice(0, 18) + '…');
const profiles = new Map<string, string>();
const pics = new Map<string, string>();
const profileOf = (p?: NEvent) => { if (!p) return; try { const j = JSON.parse(p.content); profiles.set(p.pubkey, j.name || j.display_name || ''); if (j.picture) pics.set(p.pubkey, j.picture); } catch { /* skip */ } };
profileOf((await q({ authors: [pk], kinds: [0] }))[0]);

const notes = (await q({ authors: [pk], kinds: [1], limit: 60 })).sort((a, b) => b.created_at - a.created_at);
const topLevel = notes.filter((n) => !n.tags.some((t) => t[0] === 'e'));
const note = topLevel.find(hasImage) ?? topLevel[0] ?? notes[0]; // prefer a top-level note WITH an image
const article = (await q({ authors: [pk], kinds: [30023] })).sort((a, b) => b.created_at - a.created_at)[0];
const bookmarks = (await q({ authors: [pk], kinds: [10003] }))[0];

const store: NEvent[] = [];
if (bookmarks) {
    const eRefs = bookmarks.tags.filter((t) => t[0] === 'e').map((t) => t[1]).filter(Boolean).slice(0, 24);
    const aRefs = bookmarks.tags.filter((t) => t[0] === 'a').map((t) => t[1]).filter(Boolean).slice(0, 12);
    if (eRefs.length) store.push(...await q({ ids: eRefs }));
    for (const c of aRefs) { const [k, a, d] = c.split(':'); const r = await q({ kinds: [Number(k)], authors: [a], '#d': [d ?? ''] }); if (r[0]) store.push(r[0]); }
}
const authors = [...new Set([...store.map((e) => e.pubkey), article?.pubkey].filter(Boolean) as string[])].filter((a) => !profiles.has(a));
if (authors.length) for (const p of await q({ kinds: [0], authors })) profileOf(p);

// --- Satori-themed renderers (emit Satori classes; styled by the inlined Satori CSS) ------------
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c));
const nameOf = (pkx: string): string => profiles.get(pkx) || pkx.slice(0, 8) + '…';
const hue = (pkx: string): number => parseInt(pkx.slice(0, 8), 16) % 36;
const avatar = (pkx: string, sm = false): string => {
    const cls = sm ? 'avatar avatar-sm' : 'avatar';
    const pic = pics.get(pkx);
    return pic ? `<img class="${cls}" src="${esc(pic)}" alt="" loading="lazy">` : `<span class="${cls} avatar-blank avatar-h${hue(pkx)}"></span>`;
};
function timeAgo(ts: number): string {
    const s = Math.floor(Date.now() / 1000) - ts;
    if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 2592000) return Math.floor(s / 86400) + 'd';
    return new Date(ts * 1000).toLocaleDateString();
}
const acts = (m: Manifest): string => `<div class="note-actions"><div class="note-acts">${m.actions.map((a) => `<span class="note-act">${esc(a.label)}</span>`).join('')}</div></div>`;

// A note body is a RICH-CONTENT slot, not plain text: inline media + mentions + links. The engine
// owns that parsing - here, image URLs become Satori `.media` tiles through the same mediaProxy seam
// as image slots (prod: /media SSRF-guarded + Tor; lab: pass-through). The manifest just says "content".
const media = (url: string): string => url; // prod: '/media?u=' + encodeURIComponent(url)
function richContent(content: string): string {
    const re = new RegExp(`https?://\\S+\\.${IMG}(?:\\?\\S*)?`, 'ig');
    let out = '', last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
        out += esc(content.slice(last, m.index));
        out += `<a class="media-link" href="${esc(media(m[0]))}" target="_blank" rel="noreferrer"><img class="media" src="${esc(media(m[0]))}" loading="lazy" alt=""></a>`;
        last = m.index + m[0].length;
    }
    return out + esc(content.slice(last));
}

function noteSatori(ev: NEvent, m: Manifest, r: Extract<Render, { layout: 'card' }>): string {
    const title = r.title ? resolveBinding(ev, r.title) : '';
    const body = r.body ? resolveBinding(ev, r.body) : '';
    const main = body || title;
    const head = title && body && title !== body ? `<div class="ncard-title">${esc(title)}</div>` : '';
    const fields = (r.fields ?? []).map((f) => resolveBinding(ev, f.value)).filter(Boolean).map((v) => `<span class="ncard-field">${esc(v)}</span>`).join('');
    return `<li class="note">${avatar(ev.pubkey)}
  <div class="note-body">
    <div class="note-head"><a class="author">${esc(nameOf(ev.pubkey))}</a><span class="time">${timeAgo(ev.created_at)}</span></div>
    ${head}${fields ? `<div class="ncard-fields">${fields}</div>` : ''}
    <div class="content">${richContent(main)}</div>
    ${acts(m)}
  </div></li>`;
}

function articleSatori(ev: NEvent, m: Manifest, r: Extract<Render, { layout: 'reader' }>): string {
    const cover = r.cover ? resolveBinding(ev, r.cover) : '';
    const summary = r.summary ? resolveBinding(ev, r.summary) : '';
    const paras = resolveBinding(ev, r.body).split(/\n\n+/).map((p) => p.trim()).filter(Boolean).slice(0, 8)
        .map((p) => `<p>${esc(p.replace(/^#+\s*/, ''))}</p>`).join('\n  ');
    return `<article class="article">
  ${cover ? `<img class="article-cover" src="${esc(cover)}" alt="">` : ''}
  <h1 class="article-title">${esc(resolveBinding(ev, r.title)) || '(untitled)'}</h1>
  <div class="article-byline">${avatar(ev.pubkey, true)} ${esc(nameOf(ev.pubkey))} · ${timeAgo(ev.created_at)}</div>
  ${summary ? `<p class="ncard-summary">${esc(summary)}</p>` : ''}
  <div class="article-body">${paras}</div>
  ${acts(m)}
</article>`;
}

function listSatori(ev: NEvent, m: Manifest, r: Extract<Render, { layout: 'list' }>, env: Env): string {
    const refs = ev.tags.filter((t) => r.refs.includes(t[0])).map((t) => t[1]).filter(Boolean);
    const rows = refs.map((ref) => {
        const item = env.resolve(ref);
        if (!item) return `<li class="note"><span class="avatar avatar-sm avatar-blank"></span><div class="note-body"><div class="content nli-missing">unresolved reference</div></div></li>`;
        const im = env.manifestFor(item.kind);
        const label = im ? (im.render.layout === 'reader' ? resolveBinding(item, { tag: 'title' }) : resolveBinding(item, { field: 'content' })) : item.content;
        const compact = (label || '(untitled)').replace(/\s+/g, ' ').trim().slice(0, 140);
        return `<li class="note">${avatar(item.pubkey, true)}
    <div class="note-body"><div class="note-head"><a class="author">${esc(nameOf(item.pubkey))}</a><span class="time">${im ? esc(im.name) : 'kind ' + item.kind}</span></div>
    <div class="content">${esc(compact)}</div></div></li>`;
    });
    return `<h3 class="settings-head">${esc(resolveBinding(ev, r.title))}</h3><ul class="feed">${rows.join('\n  ')}</ul>`;
}

const env: Env = { resolve: (ref) => store.find((e) => e.id === ref || coordOf(e) === ref), manifestFor: (k) => byKind.get(k) };
const sections: string[] = [];
if (note) sections.push(`<ul class="feed">${noteSatori(note, noteManifest, noteManifest.render as never)}</ul>`);
if (article) sections.push(articleSatori(article, articleManifest, articleManifest.render as never));
if (bookmarks) sections.push(listSatori(bookmarks, bookmarkManifest, bookmarkManifest.render as never, env));
console.log(`note:${note ? ' ok' : ' none'} | article:${article ? ` "${resolveBinding(article, { tag: 'title' })}"` : ' none'} | bookmarks:${bookmarks ? ` ${store.length} refs resolved` : ' none'}`);

// --- inline Satori's REAL stylesheet + a few engine-class supplements ----------------------------
const satoriCss = readFileSync('public/styles.css', 'utf8');
const supplement = `.ncard-title{font-family:var(--serif);font-weight:600;font-size:17px;margin:0 0 6px}
.ncard-fields{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin:0 0 8px}
.ncard-summary{color:var(--muted);font-size:16px;font-style:italic;margin:0 0 20px}
.nli-missing{color:var(--muted);font-style:italic}
body{padding:0}.lab-main{max-width:600px;margin:0 auto;padding:20px}
.lab-note{color:var(--muted);font-size:13px;border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:18px}`;
const page = `<!doctype html><html data-theme="sumi-e-dark"><head><meta charset=utf8><title>NATEOAS - live, Satori-themed</title>
<style>${satoriCss}\n${supplement}</style></head><body><main class="lab-main">
<p class="lab-note">Live Nostr data for ${esc(profiles.get(pk) || 'this npub')}, rendered by the generic NATEOAS engine but emitting Satori's class vocabulary + inlining Satori's real styles.css. The engine logic + manifests are unchanged from the synthetic demo; only the theme markup differs. Action glyphs are simplified labels (the real icons live in Satori's SVG set).</p>
${sections.join('\n')}
</main></body></html>`;
writeFileSync('/tmp/nateoas-vocab.html', page);
console.log('Wrote /tmp/nateoas-vocab.html');
pool.close(RELAYS);
setTimeout(() => process.exit(0), 300);
