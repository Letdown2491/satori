// Stateful action button fragments. Each is a <form> whose POST returns the new
// button (helmjs swaps it in place via the form's h-target/h-swap; with JS off the
// server 303-redirects to the same page for a full reload). The continuation
// returns the identical form with toggled state, so the swap is seamless.

import { html, type SafeHtml } from '../html.ts';
import { icon, type IconName } from './svg.ts';
import { isOn, type ActionName } from '../actions.ts';
import { isLiked } from '../likes.ts';
import type { Session } from '../session.ts';

/** A stable element id for an action+target, used as the swap target. */
function actId(action: ActionName, target: string): string {
    return `act-${action}-${target}`;
}

/** An icon action (bookmark / pin) on a note - the `.note-act` ink glyph that
 * fills + accents when active. The form targets itself and outer-swaps. */
function iconAction(action: ActionName, target: string, on: boolean, name: IconName, title: string): SafeHtml {
    const id = actId(action, target);
    // h-optimistic flips `.active` on the glyph the instant you click (the response
    // swap reconciles to server truth; an h:error - failed publish or rejected
    // signature - reverts it). The target is the .note-act button, since that's what
    // the `.active` styling keys off.
    return html`<form id="${id}" class="act-form" action="/act/${action}/${target}" method="post" h-post h-target="#${id}" h-swap="outer" h-optimistic="class:active" h-optimistic-target="#${id} .note-act">
        <button type="submit" class="note-act ${action} ${on ? 'active' : ''}" title="${on ? `${title} ✓` : title}" aria-label="${title}" aria-pressed="${on ? 'true' : 'false'}">${icon(name, on)}</button>
      </form>`;
}

export function bookmarkButton(s: Session, noteId: string): SafeHtml {
    return iconAction('bookmark', noteId, isOn(s, 'bookmark', noteId), 'bookmark', 'Bookmark');
}

export function pinButton(s: Session, noteId: string): SafeHtml {
    return iconAction('pin', noteId, isOn(s, 'pin', noteId), 'pin', 'Pin to profile');
}

/** Mute-this-person glyph for stranger-facing rows (notifications, Commons). Unlike the
 * note-keyed toggles it targets the AUTHOR; on success it removes the whole card (the route
 * returns an empty body retargeted at `#card-<eventId>`), so muting dismisses the item. The
 * glyph flips optimistically the instant you click, then the card drops once mute persists. */
export function muteAct(s: Session, pubkey: string, eventId: string): SafeHtml {
    const id = actId('mute', pubkey);
    const on = isOn(s, 'mute', pubkey);
    return html`<form id="${id}" class="act-form" action="/act/mute/${pubkey}?card=${eventId}" method="post" h-post h-target="#card-${eventId}" h-swap="outer" h-transition h-optimistic="class:active" h-optimistic-target="#${id} .note-act">
        <button type="submit" class="note-act mute ${on ? 'active' : ''}" title="${on ? 'Muted ✓' : 'Mute this person'}" aria-label="Mute this person" aria-pressed="${on ? 'true' : 'false'}">${icon('mute', on)}</button>
      </form>`;
}

/** The like button (NIP-25). Unlike the list toggles, a like is a per-note kind:7
 * event, so state comes from the likes cache (not a list) and the form carries the
 * note author (needed for the like's p-tag). Fills the heart when liked. */
export function likeButton(s: Session, noteId: string, author: string): SafeHtml {
    const on = isLiked(s, noteId);
    const id = `like-${noteId}`;
    return html`<form id="${id}" class="act-form" action="/like/${noteId}" method="post" h-post h-target="#${id}" h-swap="outer" h-optimistic="class:active" h-optimistic-target="#${id} .note-act">
        <input type="hidden" name="author" value="${author}">
        <button type="submit" class="note-act like ${on ? 'active' : ''}" title="${on ? 'Liked ✓' : 'Like'}" aria-label="Like" aria-pressed="${on ? 'true' : 'false'}">${icon('like', on)}</button>
      </form>`;
}

/** A text action (follow / mute) on a profile - `.follow-btn` / `.mute-btn`. The
 * on/off labels are BOTH rendered (shown by CSS via the state class), so an
 * optimistic toggle of that class flips the look AND the text instantly; the
 * response swap reconciles, an h:error reverts. */
function textAction(action: ActionName, target: string, on: boolean, cls: string, stateClass: string, onLabel: string, offLabel: string): SafeHtml {
    const id = actId(action, target);
    return html`<form id="${id}" class="act-form" action="/act/${action}/${target}" method="post" h-post h-target="#${id}" h-swap="outer" h-optimistic="class:${stateClass}" h-optimistic-target="#${id} button">
        <button type="submit" class="${cls} ${on ? stateClass : ''}" aria-pressed="${on ? 'true' : 'false'}">
          <span class="label-off">${offLabel}</span><span class="label-on">${onLabel}</span>
        </button>
      </form>`;
}

export function followButton(s: Session, pubkey: string): SafeHtml {
    return textAction('follow', pubkey, isOn(s, 'follow', pubkey), 'follow-btn', 'following', 'Following', 'Follow');
}

export function muteButton(s: Session, pubkey: string): SafeHtml {
    return textAction('mute', pubkey, isOn(s, 'mute', pubkey), 'mute-btn ghost', 'muted', 'Muted', 'Mute');
}

/** The right fragment to return after a toggle, by action name. */
export function actionButton(s: Session, action: ActionName, target: string): SafeHtml {
    switch (action) {
        case 'bookmark': return bookmarkButton(s, target);
        case 'pin': return pinButton(s, target);
        case 'follow': return followButton(s, target);
        case 'mute': return muteButton(s, target);
    }
}
