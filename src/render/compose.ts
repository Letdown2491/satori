// Shared compose render helpers. mediaItem lives here (not in a route) so both
// the compose form (routes/note.ts) and the upload handler (routes/upload.ts)
// can render an attached item without a route↔route import cycle.

import { randomBytes } from 'node:crypto';
import { html, raw, type SafeHtml } from '../html.ts';
import { imgSrc } from './content.ts';

/** The compose file input. After an enhanced Attach, /upload re-emits this with
 * `h-oob` so helmjs swaps it (by id) back to empty - otherwise the input keeps
 * its selection and the file would ride along to the next Publish. */
export function composeFileInput(oob = false): SafeHtml {
    return html`<input type="file" id="compose-file" name="file" accept="image/*,video/*" aria-label="Add photo or video"${oob ? raw(' h-oob="true"') : raw('')}>`;
}

/** One uploaded item: a single hidden input carrying the NIP-92 imeta tag (which
 * holds the url + mime - the one source of truth POST /note reads back), plus a
 * thumbnail and a ✕ that removes just this item (helmjs outer-swap with empty). */
export function mediaItem(imeta: string[]): SafeHtml {
    const id = `media-${randomBytes(6).toString('hex')}`;
    const url = imeta.find((t) => t.startsWith('url '))?.slice(4) ?? '';
    const mime = imeta.find((t) => t.startsWith('m '))?.slice(2) ?? '';
    const thumb = mime.startsWith('video/')
        ? html`<video class="media-thumb" src="${url}" muted></video>`
        : html`<img class="media-thumb" src="${imgSrc(url)}" alt="attachment">`;
    return html`
      <div class="media-item" id="${id}">
        <input type="hidden" name="imeta" value="${JSON.stringify(imeta)}">
        ${thumb}
        <button type="button" class="media-remove" title="Remove" aria-label="Remove"
                h-get="/compose/close" h-target="#${raw(id)}" h-swap="outer" h-push-url="false">✕</button>
      </div>`;
}

/** The undo-window countdown toast (fixed, bottom). It POLLS /note/tick every 1s
 * to re-render the countdown; at the deadline the tick publishes and body-swaps the
 * feed (this toast disappears with it). Undo POSTs /note/undo → the held event is
 * discarded and the toast removed. Zero app JS. */
export function undoToast(token: string, seconds: number): SafeHtml {
    const t = encodeURIComponent(token);
    return html`
      <div id="undo-toast" class="toast undo-toast show" role="status" aria-live="polite"
           h-get="/note/tick?token=${t}" h-trigger="every 1s" h-target="#undo-toast" h-swap="outer" h-push-url="false">
        <span>Posting in ${String(seconds)}s…</span>
        <button class="toast-action" h-post="/note/undo?token=${t}" h-target="#undo-toast" h-swap="outer">Undo</button>
      </div>`;
}
