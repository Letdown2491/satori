// Shared compose render helpers. mediaItem lives here (not in a route) so both
// the compose form (routes/note.ts) and the upload handler (routes/upload.ts)
// can render an attached item without a route↔route import cycle.

import { randomBytes } from 'node:crypto';
import { html, raw, type SafeHtml } from '../html.ts';
import { imgSrc } from './content.ts';
import { icon } from './svg.ts';
import { minScheduleValue } from './util.ts';
import { torStrict } from '../privacy.ts';

/** The revealed "Publish on <datetime> [Schedule]" row, shared by the note (POST /note) and article
 * (POST /article) composers so the markup can't drift. The clock toggle + reveal are pure CSS (the caller
 * supplies the #schedule-toggle checkbox + .schedule-btn label). `btnAttrs` carries the note composer's
 * helmjs swap target (the article posts via its plain boosted form, so it passes none). */
export function scheduleRow(action: string, btnAttrs: SafeHtml = raw('')): SafeHtml {
    return html`<div class="schedule-row">
          <span class="schedule-label">Publish on</span>
          <input class="schedule-input" type="datetime-local" name="schedule" min="${minScheduleValue()}" aria-label="Schedule for later">
          <button type="submit" class="ghost schedule-go" name="do" value="schedule" formaction="${action}" formmethod="post"${btnAttrs} title="Publish at this time (the daemon sends it even if your browser is closed)">Schedule</button>
        </div>`;
}

/** The compose file input. After an enhanced Attach, /upload re-emits this with
 * `h-oob` so helmjs swaps it (by id) back to empty - otherwise the input keeps
 * its selection and the file would ride along to the next Publish. */
export function composeFileInput(oob = false): SafeHtml {
    return html`<input type="file" id="compose-file" name="file" accept="image/*,video/*" aria-label="Add photo or video"${oob ? raw(' h-oob="true"') : raw('')}>`;
}

/** The modal-head ✕ close button: clears #modal via /compose/close. Shared by every modal head
 * (compose, zap, profile-edit, new-message). */
export function modalClose(): SafeHtml {
    return html`<button class="modal-close" h-get="/compose/close" h-target="#modal" h-swap="inner" h-push-url="false" title="Close" aria-label="Close">✕</button>`;
}

/** One uploaded item: a single hidden input carrying the NIP-92 imeta tag (which
 * holds the url + mime - the one source of truth POST /note reads back), plus a
 * thumbnail and a ✕ that removes just this item (helmjs outer-swap with empty). */
export function mediaItem(imeta: string[]): SafeHtml {
    const id = `media-${randomBytes(6).toString('hex')}`;
    const url = imeta.find((t) => t.startsWith('url '))?.slice(4) ?? '';
    const mime = imeta.find((t) => t.startsWith('m '))?.slice(2) ?? '';
    // Strict Privacy Mode: a raw <video src> would fetch (metadata) browser→host, leaking your IP even for
    // your own upload. Show a non-loading video glyph instead - the imeta hidden input still carries the url.
    const thumb = !mime.startsWith('video/') ? html`<img class="media-thumb" src="${imgSrc(url)}" alt="attachment">`
        : torStrict() ? html`<div class="media-thumb media-thumb-vid">${icon('play', true)}</div>`
        : html`<video class="media-thumb" src="${url}" muted></video>`;
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
