// GET /compose/suggest - server-backed typeahead for the composer (@-mentions +
// :emoji), mirroring Satori's inline autocomplete. helmjs sends the textarea
// value (h-include) + the caret position (H-Selection-Start, via h-selection);
// we detect the active token before the caret and return a dropdown of
// [role=option] buttons carrying h-insert/h-insert-replace, so helmjs splices the
// choice into the textarea at the caret (replacing the token) with no app JS.
// Keyboard nav (arrows/enter/escape) is helmjs's h-combobox on the textarea.

import { npubEncode } from 'nostr-tools/nip19';
import { requireLogin, ensureProfiles } from './common.ts';
import { ensureLists } from '../actions.ts';
import { searchEmoji, type Emoji } from '../emoji.ts';
import { avatar, displayName } from '../render/util.ts';
import { withEmoji } from '../render/content.ts';
import { html, raw, type SafeHtml } from '../html.ts';
import { sendFragment, type Ctx } from '../http.ts';
import type { Session } from '../session.ts';

// Token detection (Satori's regexes): a '@'/':' at a word boundary, up to the
// caret. The h-insert-replace regexes are anchored at the caret so helmjs
// replaces just the typed token (not the leading space).
const MENTION_RE = /(?:^|\s)@(\w{0,30})$/;
const EMOJI_RE = /(?:^|\s):([a-z0-9_+-]+)$/;
const MENTION_REPLACE = '@\\w*$';
const EMOJI_REPLACE = ':[a-z0-9_+-]*$';
const TEXTAREA = '#compose-text';
const FOLLOW_KIND = 3;

function followsSet(s: Session & { me: string }): Set<string> {
    const set = new Set<string>();
    const ev = s.lists.get(FOLLOW_KIND);
    if (ev) for (const t of ev.tags) if (t[0] === 'p' && t[1]) set.add(t[1]);
    return set;
}

/** Mirror Satori's searchProfiles: name/nip05 substring over loaded profiles,
 * follows sorted first; a bare '@' lists your follows. */
function searchProfiles(s: Session & { me: string }, query: string): string[] {
    const follows = followsSet(s);
    if (!query) return [...follows].slice(0, 6);
    const out: string[] = [];
    for (const [pk, p] of s.profiles) {
        const name = (p.name ?? p.display_name ?? '').toLowerCase();
        const nip05 = (p.nip05 ?? '').toLowerCase();
        if (name.includes(query) || nip05.includes(query)) out.push(pk);
    }
    out.sort((a, b) => (follows.has(b) ? 1 : 0) - (follows.has(a) ? 1 : 0));
    return out.slice(0, 6);
}

function option(i: number, insert: string, replace: string, body: SafeHtml, extra = ''): SafeHtml {
    return html`<button type="button" role="option" id="sug-${i}" class="mention-opt${extra ? ` ${extra}` : ''}${i === 0 ? ' h-active' : ''}"
        h-insert="${insert}" h-insert-target="${raw(TEXTAREA)}" h-insert-replace="${replace}">${body}</button>`;
}

function mentionOptions(s: Session & { me: string }, pks: string[]): SafeHtml {
    return html`${pks.map((pk, i) => {
        const p = s.profiles.get(pk);
        return option(i, `nostr:${npubEncode(pk)} `, MENTION_REPLACE, html`
            ${avatar(pk, p?.picture, 'xs')}<span class="mention-opt-name">${withEmoji(displayName(pk, s.profiles), p?.emoji)}</span>${p?.nip05 ? html`<span class="mention-opt-nip05">${p.nip05}</span>` : null}`);
    })}`;
}

function emojiOptions(matches: Emoji[]): SafeHtml {
    return html`${matches.map((em, i) => option(i, em.char, EMOJI_REPLACE,
        html`<span class="emoji-char">${em.char}</span><span class="mention-opt-name">:${em.name}:</span>`, 'emoji-opt'))}`;
}

export async function getSuggest(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const content = ctx.query.get('content') ?? '';
    const caretH = ctx.req.headers['h-selection-start'];
    const caret = typeof caretH === 'string' && /^\d+$/.test(caretH) ? Math.min(Number(caretH), content.length) : content.length;
    const before = content.slice(0, caret);

    const mm = MENTION_RE.exec(before);
    if (mm) {
        await ensureLists(s, ['follow']);
        const pks = searchProfiles(s, mm[1]!.toLowerCase());
        if (pks.length) {
            await ensureProfiles(s, pks).catch(() => { /* names degrade to npub */ });
            sendFragment(ctx, mentionOptions(s, pks));
            return;
        }
    }
    const em = EMOJI_RE.exec(before);
    if (em) {
        const matches = searchEmoji(em[1]!);
        if (matches.length) { sendFragment(ctx, emojiOptions(matches)); return; }
    }
    sendFragment(ctx, html``); // no active token / no matches → clear the dropdown
}
