// NIP-25 like toggle. POST /like/:target creates a kind:7 "+" (or deletes it via
// kind:5 when already liked); for nip07 it returns H-Nostr-Sign and POST
// /like/:target/publish is the continuation. Both end by swapping the updated
// heart in place (helmjs), or - zero-JS bunker - reloading the originating page.
// `:target` is a note id (hex, `e`-tag like) OR an article naddr (`a`-tag like); the
// cache key + DOM id stay the target string verbatim (the canonical naddr matches naddrFor).

import { html } from '../html.ts';
import { decode } from 'nostr-tools/nip19';
import { likeTemplate, articleLikeTemplate, unlikeTemplate, pickReaction } from '../data/reactions.ts';
import { cachedLikeId, setLike, clearLike } from '../data/engagement-cache.ts';
import { published, writeRelays } from '../actions.ts';
import { likeButton } from '../render/actions.ts';
import { readSignedEvent } from '../nip07.ts';
import { requireLogin } from './common.ts';
import { readForm, redirect, safeReferer, sendFragment, sendSignRequest, notFound, type Ctx } from '../http.ts';
import type { Session } from '../session.ts';
import { signsOnClient } from '../session.ts';

const HEX64 = /^[0-9a-f]{64}$/i;

/** Resolve a like target: a note (hex id) or an article (naddr → address). Returns the author
 * (for the like's p-tag + the rendered button) and, for an article, the `a`-tag inputs. */
function likeTarget(target: string, formAuthor: string): { author: string; addr?: { address: string; pubkey: string; kind: number } } | null {
    if (target.startsWith('naddr1')) {
        try {
            const d = decode(target);
            if (d.type !== 'naddr') return null;
            const { kind, pubkey, identifier } = d.data;
            return { author: pubkey, addr: { address: `${kind}:${pubkey}:${identifier}`, pubkey, kind } };
        } catch { return null; }
    }
    if (!HEX64.test(target) || !HEX64.test(formAuthor)) return null;
    return { author: formAuthor };
}

function respond(ctx: Ctx, s: Session & { me: string }, noteId: string, author: string): void {
    if (ctx.isPartial) sendFragment(ctx, likeButton(s, noteId, author));
    else redirect(ctx, safeReferer(ctx));
}

export async function postLike(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    if (!s.reactions) { notFound(ctx); return; } // reactions disabled in settings → no like emission
    const noteId = ctx.params.target ?? '';
    const form = await readForm(ctx.req);
    const t = likeTarget(noteId, (form.get('author') ?? '').trim());
    if (!t) { notFound(ctx); return; }
    const author = t.author;

    const existing = cachedLikeId(s.me, noteId) ?? null; // current state (+ reaction id to unlike) from the cache
    const op = existing ? 'unlike' : 'like';
    const emoji = pickReaction(form.get('emoji')); // which reaction to add (palette-validated; '+' = heart). Ignored on unlike.
    const template = existing ? unlikeTemplate(s.me, existing)
        : t.addr ? articleLikeTemplate(s.me, t.addr, emoji) : likeTemplate(s.me, { id: noteId, pubkey: author }, emoji);

    // nip07: the extension signs; the continuation publishes + updates state.
    if (signsOnClient(s)) { sendSignRequest(ctx, template, `/like/${noteId}/publish?author=${author}&op=${op}&emoji=${encodeURIComponent(emoji)}`); return; }

    // bunker: sign + publish here.
    try {
        const signed = await s.signer!.signEvent(template);
        await s.pool.publish(writeRelays(s), signed);
        if (op === 'like') setLike(s.me, noteId, signed.id, emoji); else clearLike(s.me, noteId);
    } catch (err) {
        sendFragment(ctx, html`<div class="notice error">Couldn't ${op}: ${err instanceof Error ? err.message : String(err)}</div>`, {}, 502);
        return;
    }
    respond(ctx, s, noteId, author);
}

/** nip07 continuation: verify the extension-signed reaction/deletion, publish, swap. */
export async function postLikePublish(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    if (!s.reactions) { notFound(ctx); return; } // reactions disabled → reject the continuation too
    const noteId = ctx.params.target ?? '';
    const author = (ctx.query.get('author') ?? '').trim();
    const op = ctx.query.get('op') === 'unlike' ? 'unlike' : 'like';
    const emoji = pickReaction(ctx.query.get('emoji'));
    // Decode-validate (not just the `naddr1` prefix): a non-canonical target would otherwise reach
    // the `H-Retarget: #like-<target>` header below. likeTarget() rejects anything that isn't a hex
    // note id or a real naddr, so only the safe bech32 charset can flow into the selector.
    if (!likeTarget(noteId, author)) { notFound(ctx); return; }

    const signed = await readSignedEvent(ctx.req);
    if (!signed || signed.pubkey !== s.me || signed.kind !== (op === 'like' ? 7 : 5)) {
        sendFragment(ctx, html`<div class="notice error">Couldn't verify the like.</div>`, {}, 400);
        return;
    }
    if (!await published(s, signed)) {
        sendFragment(ctx, html`<div class="notice error">Couldn't ${op === 'like' ? 'like' : 'unlike'} that - no relay accepted it.</div>`, {}, 502);
        return;
    }
    if (op === 'like') setLike(s.me, noteId, signed.id, emoji); else clearLike(s.me, noteId);
    // Declare placement: the sign-request set H-Reswap:none (so a non-plugin client
    // won't swap the JSON template), which mutates the request's swap to "none". The
    // continuation must re-assert the swap or the heart never updates (only a reload
    // would). Mirrors the note-publish flow's LAND_ON_FEED headers.
    sendFragment(ctx, likeButton(s, noteId, author), { 'H-Reswap': 'outer', 'H-Retarget': `#like-${noteId}` });
}
