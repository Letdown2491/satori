// NIP-09 event deletion. POST /delete/:id swaps the trash glyph for an inline confirm
// (nothing is signed yet); POST /delete/:id/confirm builds the kind:5 - bunker signs and
// publishes here, nip07 gets H-Nostr-Sign with POST /delete/:id/publish as the continuation;
// POST /delete/:id/cancel restores the glyph. Only your own events: the glyph only renders on
// them, ownership is re-checked against the event cache when possible, and the kind:5 is
// signed by YOUR key regardless - relays (and our tombstone lookups) both pubkey-match, so a
// forged target could never delete someone else's event anyway.

import { html, type SafeHtml } from '../html.ts';
import { icon } from '../render/svg.ts';
import { deleteActRaw } from '../render/actions.ts';
import { published } from '../actions.ts';
import { cachedEvent } from '../data/feeds.ts';
import { requireSigned } from '../nip07.ts';
import { requireLogin } from './common.ts';
import { readForm, redirect, safeReferer, sendFragment, sendSignRequest, notFound, type Ctx } from '../http.ts';
import { HEX64, coordParts, nowSec } from '../nostr/tags.ts';
import type { UnsignedEvent } from '../nostr/types.ts';
import { signsOnClient } from '../session.ts';

interface DelTarget { id: string; k: number; coord: string }

/** Validate the delete target from the form/query: a hex event id, an integer kind, and - for
 * an addressable kind - a coordinate that PARSES, matches the kind, and names YOUR pubkey (an
 * `a` tag for someone else's address is a cross-author deletion attempt; reject the request). */
function parseDelete(ctx: Ctx, me: string, p: { get(n: string): string | null }): DelTarget | null {
    const id = (ctx.params.id ?? '').toLowerCase();
    if (!HEX64.test(id)) return null;
    const k = Number(p.get('k'));
    if (!Number.isInteger(k) || k < 0 || k > 65535) return null;
    const coord = (p.get('a') ?? '').trim();
    if (coord) {
        const c = coordParts(coord);
        if (!c || c.kind !== k || c.pubkey !== me) return null;
    }
    // Ownership re-check when the event is at hand (the UI only renders the glyph on own posts,
    // but the POST is forgeable): a cached copy that isn't yours kills the request. An uncached
    // id proceeds - the kind:5 is signed by you, so it can't touch anyone else's event.
    const cached = cachedEvent(id);
    if (cached && cached.pubkey !== me) return null;
    return { id, k, coord };
}

/** The kind:5 deletion request: `e` = the event, `a` beside it for an addressable kind
 * (NIP-09 recommends both), `k` = the deleted event's kind. */
function deleteTemplate(me: string, t: DelTarget): UnsignedEvent {
    const tags = [['e', t.id], ...(t.coord ? [['a', t.coord]] : []), ['k', String(t.k)]];
    return { kind: 5, created_at: nowSec(), pubkey: me, content: '', tags };
}

const hiddenFields = (t: DelTarget): SafeHtml =>
    html`<input type="hidden" name="k" value="${String(t.k)}">${t.coord ? html`<input type="hidden" name="a" value="${t.coord}">` : null}`;

/** The armed state: confirm + keep, two sibling forms swapping the same slot (a form can't
 * nest, and one form with two formactions doesn't survive the helmjs submit path). */
function confirmFragment(t: DelTarget): SafeHtml {
    return html`<span id="del-${t.id}" class="del-confirm">
        <form class="act-form" action="/delete/${t.id}/confirm" method="post" h-post h-target="#del-${t.id}" h-swap="outer">${hiddenFields(t)}
          <button type="submit" class="note-act delete active" title="Yes, delete it" aria-label="Yes, delete it">${icon('trash', true)}</button></form>
        <form class="act-form" action="/delete/${t.id}/cancel" method="post" h-post h-target="#del-${t.id}" h-swap="outer">${hiddenFields(t)}
          <button type="submit" class="note-act" title="Keep it" aria-label="Keep it">${icon('back')}</button></form>
      </span>`;
}

/** Post-delete state: an inert glyph. The card itself drops on the next page load - the
 * tombstone is already recorded, so every future render filters the event out. */
const deletedFragment = (id: string): SafeHtml =>
    html`<span id="del-${id}" class="note-act delete deleted" title="Deleted - relays that honor deletion requests will drop it">${icon('trash', true)}<span class="sr-only">Deleted</span></span>`;

function respondFragment(ctx: Ctx, body: SafeHtml, id: string): void {
    if (ctx.isPartial) sendFragment(ctx, body, { 'H-Reswap': 'outer', 'H-Retarget': `#del-${id}` });
    else redirect(ctx, safeReferer(ctx));
}

/** Arm: swap the glyph for the inline confirm. Zero-JS gets no interstitial page - the
 * redirect just lands back, and the (JS-free) confirm renders on the next click path - so
 * a full-page fallback POST simply requires the helmjs swap; this is a JS-era affordance
 * with a harmless no-op fallback, like the compose modal. */
export async function postDelete(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const t = parseDelete(ctx, s.me, await readForm(ctx.req));
    if (!t) { notFound(ctx); return; }
    respondFragment(ctx, confirmFragment(t), t.id);
}

/** Disarm: put the original glyph back. */
export async function postDeleteCancel(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const t = parseDelete(ctx, s.me, await readForm(ctx.req));
    if (!t) { notFound(ctx); return; }
    respondFragment(ctx, deleteActRaw(t.id, t.k, t.coord), t.id);
}

/** Confirmed: build the kind:5. Bunker signs + publishes here; nip07 hands the template to the
 * extension with /delete/:id/publish as the continuation. */
export async function postDeleteConfirm(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const t = parseDelete(ctx, s.me, await readForm(ctx.req));
    if (!t) { notFound(ctx); return; }
    const template = deleteTemplate(s.me, t);

    if (signsOnClient(s)) {
        sendSignRequest(ctx, template, `/delete/${t.id}/publish?k=${t.k}${t.coord ? `&a=${encodeURIComponent(t.coord)}` : ''}`);
        return;
    }
    try {
        const signed = await s.signer!.signEvent(template);
        if (!await published(s, signed)) throw new Error('no relay accepted it');
    } catch (err) {
        sendFragment(ctx, html`<div class="notice error">Couldn't delete: ${err instanceof Error ? err.message : String(err)}</div>`, {}, 502);
        return;
    }
    respondFragment(ctx, deletedFragment(t.id), t.id);
}

/** nip07 continuation: verify the extension-signed kind:5, publish, swap in the deleted state. */
export async function postDeletePublish(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const t = parseDelete(ctx, s.me, ctx.query);
    if (!t) { notFound(ctx); return; }
    const signed = await requireSigned(ctx, s.me, 5, 'the deletion');
    if (!signed) return;
    if (!await published(s, signed)) {
        sendFragment(ctx, html`<div class="notice error">Couldn't delete: no relay accepted it.</div>`, {}, 502);
        return;
    }
    // The continuation is the lib's own fetch; re-assert placement like the other sign
    // continuations (the sign-request set H-Reswap:none).
    sendFragment(ctx, deletedFragment(t.id), { 'H-Reswap': 'outer', 'H-Retarget': `#del-${t.id}` });
}
