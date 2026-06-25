// GET /search?q= - NIP-50 search over dedicated search relays (data/search.ts),
// rendering People (kind:0) + Notes (kind:1). The form is a boosted GET so it's a
// snappy partial nav with JS and a real navigation without.

import { decode } from 'nostr-tools/nip19';
import { searchNotes, searchPeople, parseSearchQuery } from '../data/search.ts';
import { searchPage, searchResults } from '../render/search.ts';
import { requireLogin, ensureProfiles, notePubkeys, chromeFor } from './common.ts';
import { ensureLists, mutedPubkeys } from '../actions.ts';
import { ensureLikes } from '../likes.ts';
import { ensureEngaged, engageTarget } from '../engaged.ts';
import { ensureZaps } from '../zaps.ts';
import { readAppearance } from '../theme.ts';
import { sendPage, sendFragment, type Ctx } from '../http.ts';
import type { Session } from '../session.ts';
import type { Profile } from '../data/profiles.ts';

/** Resolve a by:/p: identifier to a pubkey: hex / npub / nprofile decode (sync), else a match in the
 * profile cache (exact name/nip05, then a name substring). No network - a stranger needs their npub. */
function resolvePubkey(s: Session & { me: string }, raw: string): string | null {
    if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
    try { const d = decode(raw); if (d.type === 'npub') return d.data; if (d.type === 'nprofile') return d.data.pubkey; } catch { /* not bech32 */ }
    const q = raw.toLowerCase();
    let sub: string | null = null;
    for (const [pk, p] of s.profiles) {
        const name = (p.name ?? p.display_name ?? '').toLowerCase();
        const nip05 = (p.nip05 ?? '').toLowerCase();
        if (name === q || nip05 === q || nip05.split('@')[0] === q) return pk;
        if (!sub && name.includes(q)) sub = pk;
    }
    return sub;
}

export async function getSearch(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const chrome = () => chromeFor(ctx, s, { active: 'search', title: 'Search' });
    const live = ctx.isPartial && ctx.hTarget === '#search-results'; // live-as-you-type input swap
    const q = (ctx.query.get('q') ?? '').trim();
    // Live + too-short query: swap to the seek state with NO relay fan-out (skip 0-1 char queries;
    // the 400ms input debounce already throttles). Full-nav empty query: the seek page.
    if (live && q.length < 2) { sendFragment(ctx, searchResults('', [], [], s)); return; }
    if (!q) { sendPage(ctx, searchPage('', [], [], s), chrome()); return; }

    // Parse operators (by:/p:/#tag/has:/site:/since:/until:); resolve by:/p: → pubkeys. People
    // search uses only the FREE text (operators are note-scoped); a pure-operator query skips it.
    const sq = parseSearchQuery(q);
    const authors = sq.by.map((r) => resolvePubkey(s, r)).filter((x): x is string => !!x);
    const mentions = sq.p.map((r) => resolvePubkey(s, r)).filter((x): x is string => !!x);
    const a = readAppearance(ctx);
    const [people, notesRaw] = await Promise.all([
        sq.text ? searchPeople(s.pool, a.searchProfileRelays, sq.text) : Promise.resolve([] as { pubkey: string; profile: Profile }[]),
        searchNotes(s.pool, a.searchNoteRelays, sq, authors, mentions),
    ]);
    // Cache the searched profiles so displayName/avatar render for strangers.
    for (const { pubkey, profile } of people) s.profiles.set(pubkey, profile);

    // Mute list must be loaded before filtering (people are left unfiltered - you
    // may be searching to find/unmute someone; only the note feed hides mutes).
    await ensureLists(s, ['bookmark', 'pin', 'mute']);
    const muted = mutedPubkeys(s);
    const notes = notesRaw.filter((e) => !muted.has(e.pubkey));
    await Promise.all([
        ensureProfiles(s, notePubkeys(notes)),
        ensureLikes(s, notes.map((e) => e.id)),
        ensureEngaged(s, notes.map(engageTarget)),
        ensureZaps(s),
    ]);
    if (live) { sendFragment(ctx, searchResults(q, people, notes, s)); return; }
    sendPage(ctx, searchPage(q, people, notes, s), chrome());
}
