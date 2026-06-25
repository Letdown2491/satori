// GET /search?q= - NIP-50 search over dedicated search relays (data/search.ts),
// rendering People (kind:0) + Notes (kind:1). The form is a boosted GET so it's a
// snappy partial nav with JS and a real navigation without.

import { searchNotes, searchPeople } from '../data/search.ts';
import { searchPage } from '../render/search.ts';
import { requireLogin, ensureProfiles, notePubkeys, chromeFor } from './common.ts';
import { ensureLists, mutedPubkeys } from '../actions.ts';
import { ensureLikes } from '../likes.ts';
import { ensureEngaged, engageTarget } from '../engaged.ts';
import { ensureZaps } from '../zaps.ts';
import { readAppearance } from '../theme.ts';
import { sendPage, type Ctx } from '../http.ts';

export async function getSearch(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const chrome = () => chromeFor(ctx, s, { active: 'search', title: 'Search' });
    const q = (ctx.query.get('q') ?? '').trim();
    if (!q) { sendPage(ctx, searchPage('', [], [], s), chrome()); return; }

    const a = readAppearance(ctx);
    const [people, notesRaw] = await Promise.all([
        searchPeople(s.pool, a.searchProfileRelays, q),
        searchNotes(s.pool, a.searchNoteRelays, q),
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
    sendPage(ctx, searchPage(q, people, notes, s), chrome());
}
