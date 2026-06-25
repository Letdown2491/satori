// Shared undo-window step for the publish handlers (note/reply/quote/poll, both
// signing modes). If the undo window is on, hold the signed event server-side and
// answer with the feed + a countdown toast instead of publishing now; the caller
// returns. A reply made FROM a thread (`inThread`) instead appends an optimistic
// pending reply into the open thread (and closes the modal). See undo.ts for why a
// closed tab leaves the event unpublished (it matches Satori).

import { holdPublish } from '../undo.ts';
import { undoToast } from '../render/compose.ts';
import { noteCard } from '../render/note.ts';
import { html } from '../html.ts';
import { readAppearance } from '../theme.ts';
import { feedDocument } from './feed.ts';
import { LAND_ON_FEED } from './common.ts';
import { sendFragment, type Ctx } from '../http.ts';
import type { NostrEvent } from '../nostr/types.ts';
import type { Prepared } from '../data/publish.ts';
import type { Session } from '../session.ts';

// helmjs swap vocab: `append` = insert as the last child (it maps to
// insertAdjacentHTML("beforeend") internally). NOT "beforeend" - that fails
// helmjs's H-Reswap validation, leaving the swap at the sign-request's poisoned
// "none" so the reply card is never inserted.
const APPEND_THREAD = { 'H-Retarget': '#thread', 'H-Reswap': 'append' };

/** Append a reply note (pending or confirmed) into the open thread's `#thread` list
 * and close the compose modal (OOB). The append target/swap are server-driven so
 * the boosted form's default body-swap is overridden. */
export function sendReplyToThread(
    ctx: Ctx, s: Session & { me: string }, ev: NostrEvent, inThread: string,
    pending?: { token: string; seconds: number },
): void {
    const card = noteCard(ev, s.profiles, s, { hideParent: true, depth: 0, inThread, pending });
    sendFragment(ctx, html`${card}<div id="modal" h-oob="true"></div>`, APPEND_THREAD);
}

/** Hold + show the countdown over the feed - or, for a reply made from a thread,
 * append a pending reply into that thread. Returns true (caller should return), or
 * false if the window is off and the caller should publish now. `requirePartial`
 * (default true) means a zero-JS form post skips the window; nip07 passes false. */
export async function tryUndoWindow(
    ctx: Ctx, s: Session & { me: string }, prepared: Prepared, requirePartial = true, inThread?: string,
): Promise<boolean> {
    const a = readAppearance(ctx);
    if (!a.undoEnabled || (requirePartial && !ctx.isPartial)) return false;
    const token = holdPublish(s.pool, prepared, a.undoSeconds, inThread ? { inThread } : undefined);
    if (inThread) sendReplyToThread(ctx, s, prepared.signed, inThread, { token, seconds: a.undoSeconds });
    else sendFragment(ctx, await feedDocument(ctx, s, undoToast(token, a.undoSeconds)), LAND_ON_FEED);
    return true;
}
