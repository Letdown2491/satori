// Scheduled posts now live in the Drafts page (a "Scheduled" section atop /drafts). This module
// keeps only the cancel action; /scheduled itself just redirects there. Scheduling happens in the
// compose flow (routes/note.ts); the daemon's sweep broadcasts queued posts at their time.

import { getScheduledPost, cancelScheduled, type ScheduledPost } from '../data/scheduled.ts';
import { saveDraft, newDraftId, type Draft } from '../drafts.ts';
import { requireLogin } from './common.ts';
import { redirect, type Ctx } from '../http.ts';

/** Rebuild an editable draft from a signed scheduled note (kind:1 only - scheduling is offered
 * for top-level notes). Drops the fixed send-time; keeps text, media, and content-warning. */
function scheduledToDraft(p: ScheduledPost): Draft | null {
    if (p.signed.kind !== 1) return null;
    const cw = p.signed.tags.find((t) => t[0] === 'content-warning');
    return {
        type: 'note',
        id: newDraftId(),
        content: p.signed.content,
        imeta: p.signed.tags.filter((t) => t[0] === 'imeta'),
        cw: !!cw,
        cwReason: cw?.[1] ?? '',
        savedAt: Date.now(),
    };
}

/** GET /scheduled - merged into /drafts; redirect any old links/bookmarks there. */
export function getScheduled(ctx: Ctx): void {
    redirect(ctx, '/drafts');
}

/** POST /scheduled/cancel/:token - pull a queued post and revert it to a draft, then land on
 * /drafts (boosted form follows the 303 and swaps; full nav just navigates). */
export function postScheduledCancel(ctx: Ctx): void {
    const s = requireLogin(ctx);
    if (!s) return;
    const token = ctx.params.token ?? '';
    const p = getScheduledPost(s.me, token);
    if (p) {
        const d = scheduledToDraft(p);
        if (d) saveDraft(s.me, d);
        cancelScheduled(s.me, token);
    }
    redirect(ctx, '/drafts');
}
