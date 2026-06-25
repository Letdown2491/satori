// NATEOAS strawman - FOUR kinds across FOUR archetypes, plus a local no-Nostr harness. The engine
// (engine.ts) has no per-kind logic. Run:  node lab/nateoas/demo.ts   then open /tmp/nateoas-vocab.html
//   - kind 31923 calendar event   -> 'card'   (title + fields + body)
//   - kind 30023 long-form article -> 'reader' (cover + title + summary + byline + body)
//   - kind 20    picture post      -> 'tile'   (media hero + caption)
//   - kind 30003 bookmark set      -> 'list'   (resolves heterogeneous refs, recurses into each item)

import { type NEvent, type Manifest, type Env, render, instantiate, coordOf } from './engine.ts';
import { writeFileSync } from 'node:fs';

const now = Math.floor(Date.now() / 1000);

const rsvp = (id: string, label: string, status: string) => ({
    id, label, placement: 'inline',
    template: { kind: 31925, tags: [['a', '{event.coord}'], ['e', '{event.id}'], ['p', '{event.pubkey}'], ['d', '{gen.d}'], ['status', status]], content: '' },
});
const react = (id: string, label: string, content: string) => ({
    id, label, placement: 'inline',
    template: { kind: 7, tags: [['e', '{event.id}'], ['p', '{event.pubkey}'], ['k', '{event.kind}']], content },
});

const calendarManifest: Manifest = {
    kind: 31923, name: 'Calendar event',
    render: { layout: 'card', title: { tag: 'title' }, fields: [
        { label: 'Starts', value: { tag: 'start' }, format: 'datetime' },
        { label: 'Ends', value: { tag: 'end' }, format: 'datetime' },
        { label: 'Where', value: { tag: 'location' } },
    ], body: { field: 'content' } },
    actions: [rsvp('rsvp-accepted', 'Going', 'accepted'), rsvp('rsvp-tentative', 'Maybe', 'tentative'), rsvp('rsvp-declined', "Can't go", 'declined')],
};
const articleManifest: Manifest = {
    kind: 30023, name: 'Article',
    render: { layout: 'reader', cover: { tag: 'image' }, title: { tag: 'title' }, summary: { tag: 'summary' }, byline: { tag: 'author' }, body: { field: 'content' } },
    actions: [react('react-heart', '♥ React', '+')],
};
const imageManifest: Manifest = {
    kind: 20, name: 'Picture',
    render: { layout: 'tile', media: { imeta: 'url' }, caption: { field: 'content' } },
    actions: [react('react-heart', '♥ React', '+')],
};
const collectionManifest: Manifest = {
    kind: 30003, name: 'Bookmark set',
    render: { layout: 'list', title: { tag: 'title' }, refs: ['a', 'e'] },
    actions: [],
};

// --- LOCAL STORE -------------------------------------------------------------------------------
const store: NEvent[] = [];
let seq = 0;
const put = (e: Omit<NEvent, 'id'>): NEvent => { const ev = { ...e, id: `local${++seq}` }; store.push(ev); return ev; };

const calendar = put({ pubkey: 'organizer_pubkey', kind: 31923, created_at: now,
    tags: [['d', 'nostrville-2026'], ['title', 'Nostrville Meetup'], ['start', String(now + 86400 * 7)], ['end', String(now + 86400 * 7 + 7200)], ['location', 'The Bitcoin Commons, Austin TX']],
    content: 'A calm evening of Nostr talks and zaps. Bring a friend.' });
const article = put({ pubkey: 'writer_pubkey', kind: 30023, created_at: now,
    tags: [['d', 'uncarved-block'], ['title', 'The Uncarved Block'], ['summary', 'On building calm software that does not farm your attention.'], ['image', 'https://picsum.photos/seed/uncarved/640/280'], ['author', 'Geek']],
    content: 'Simplicity is a discipline, not a default.\n\nEvery feature is a cut into the block. The craft is choosing which cuts earn their place.\n\nA network, not a scoreboard.' });
const picture = put({ pubkey: 'shooter_pubkey', kind: 20, created_at: now,
    tags: [['d', 'sumi-e-1'], ['title', 'Morning ink'], ['imeta', 'url https://picsum.photos/seed/sumie/640/420', 'm image/jpeg', 'dim 640x420', 'alt a sumi-e brushstroke']],
    content: 'First light, one stroke.' });
const note = put({ pubkey: 'someone', kind: 1, created_at: now, tags: [], content: 'just a plain note - no manifest registered for kind 1' });

// the collection references mixed kinds, plus a no-manifest kind and a dangling ref.
const collection = put({ pubkey: 'curator_pubkey', kind: 30003, created_at: now, tags: [
    ['d', 'reading-list'], ['title', 'This week'],
    ['a', coordOf(article)], ['a', coordOf(calendar)], ['e', picture.id], ['e', note.id], ['e', 'does_not_exist'],
], content: '' });

// --- the Env a `list` needs: resolve refs + find item manifests ---------------------------------
const manifestMap = new Map<number, Manifest>([[31923, calendarManifest], [30023, articleManifest], [20, imageManifest], [30003, collectionManifest]]);
const env: Env = {
    resolve: (ref) => store.find((e) => e.id === ref || coordOf(e) === ref),
    manifestFor: (kind) => manifestMap.get(kind),
};

// --- 1) RENDER all four through the SAME engine -------------------------------------------------
const cards = [render(calendar, calendarManifest), render(article, articleManifest), render(picture, imageManifest), render(collection, collectionManifest, env)];
console.log('=== Rendered 4 kinds via 4 archetypes (engine has zero per-kind logic) ===');
console.log('  card   (31923): ' + (cards[0].includes('Nostrville Meetup') ? 'ok' : 'FAIL'));
console.log('  reader (30023): ' + (cards[1].includes('ncover') ? 'ok' : 'FAIL'));
console.log('  tile   (20):    ' + (cards[2].includes('nhero') ? 'ok' : 'FAIL'));
console.log('  list   (30003): ' + (cards[3].includes('>Article<') && cards[3].includes('>Calendar event<') && cards[3].includes('>Picture<') ? 'ok (recursed into 3 item manifests)' : 'FAIL'));
console.log('         fallbacks: ' + (cards[3].includes('(no manifest)') ? 'unknown-kind ok, ' : 'FAIL, ') + (cards[3].includes('unresolved ref') ? 'unresolved ok' : 'FAIL') + '\n');

// --- 2) safety ----------------------------------------------------------------------------------
try { instantiate(article, { id: 'x', label: 'x', template: { kind: 10002, tags: [['r', 'wss://attacker']] } }, 'me'); console.log('SECURITY FAIL\n'); }
catch (e) { console.log('=== Safety: ' + (e as Error).message + ' ===\n'); }

// --- viewable page ------------------------------------------------------------------------------
const page = `<!doctype html><meta charset=utf8><title>NATEOAS archetype vocabulary</title>
<style>body{font:15px/1.55 system-ui;background:#15140f;color:#e8e2d2;max-width:600px;margin:36px auto;padding:0 16px}
article{border:1px solid #3a362c;border-radius:12px;padding:18px 20px;margin:0 0 22px}
.nkind{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b8275;margin-bottom:6px}
.nt{margin:.1em 0 .5em;font-size:21px;line-height:1.2}.n-reader .nt{font-size:26px}
.nf{display:flex;gap:10px;margin:3px 0}.nl{color:#8b8275;min-width:64px}
.nb{color:#c9c2b2;margin:.7em 0 0}
.ncover,.nhero{width:100%;border-radius:8px;display:block;margin:0 0 12px}
.nsummary{color:#c9c2b2;font-style:italic;margin:.2em 0 .6em}.nbyline{color:#8b8275;font-size:13px;margin-bottom:10px}
.nbody p{margin:.7em 0;color:#d8d2c2}.ncaption{color:#c9c2b2;margin:.6em 0 0}
.nlist{list-style:none;margin:.4em 0 0;padding:0}.nli{padding:8px 0;border-top:1px solid #2a261f}
.nli-kind{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8b8275;margin-right:8px}
.nli-missing{color:#6e695f;font-style:italic}
.nrow{display:flex;gap:8px;margin-top:16px}
.na{padding:7px 13px;border-radius:8px;border:1px solid #b23a26;background:#b23a26;color:#fff;font-weight:600;cursor:pointer}
.note{color:#8b8275;font-size:13px;margin-top:8px}</style>
<p class=note>Four kinds, four archetypes, one generic engine. The bookmark set (list) resolves heterogeneous refs and recurses into each item's own manifest for a compact label - with graceful fallbacks for a no-manifest kind and a dangling ref.</p>
${cards.join('\n')}`;
writeFileSync('/tmp/nateoas-vocab.html', page);
console.log('Wrote /tmp/nateoas-vocab.html (open in a browser).');
