// Notifications list (Satori's notifications view): replies + mentions render as
// full note cards; zaps and poll-votes are compact rows. Newest first, no counts.

import { html, type SafeHtml } from '../html.ts';
import { npubEncode, neventEncode } from 'nostr-tools/nip19';
import { noteCard } from './note.ts';
import { enso } from './svg.ts';
import { quote } from './quotes.ts';
import { avatar, displayName, timeAgo, type ProfileMap } from './util.ts';
import { withEmoji } from './content.ts';
import { emojiFromTags } from '../nostr/emoji30.ts';
import { icon } from './svg.ts';
import { replyParent } from '../nostr/nip10.ts';
import { parseZapReceipt, type Notif } from '../data/notifications.ts';
import type { NostrEvent } from '../nostr/types.ts';
import type { Session } from '../session.ts';

/** The "caught up" clearing that closes the NEW set: the boundary between new notifications
 * (above) and your already-seen history (below the "See older" control). `hadNew` is whether
 * any new items sit above it - if not, it's the calm "you're all caught up" empty state. */
export function notifCaughtUp(hadNew: boolean): SafeHtml {
    return html`<li class="empty notif-clearing" id="notif-clearing"><span>${quote('caughtUp')}</span>${hadNew ? null : html`<span class="empty-sub">You’re all caught up.</span>`}${enso(40, true)}</li>`;
}

/** The control under the clearing that reveals already-seen history (older than `until` = your
 * read high-water). Self-swaps in place with [seen rows][intersect pager], paginated continuously
 * - no gap. A real <a href> so it degrades to a full older-history page with JS off. */
export function seeOlder(until: number): SafeHtml {
    const url = `/notifications?seen=1&until=${String(until)}`;
    return html`<li class="notif-earlier" id="see-older"><a class="see-earlier quiet" href="${url}" h-get h-target="#see-older" h-swap="outer" h-push-url="false">See older notifications</a></li>`;
}

function profileLink(pubkey: string, profiles: ProfileMap): SafeHtml {
    let npub = pubkey;
    try { npub = npubEncode(pubkey); } catch { /* keep raw */ }
    return html`<a class="notif-who" href="/u/${npub}" h-scroll="top instant">${withEmoji(displayName(pubkey, profiles), profiles.get(pubkey)?.emoji)}</a>`;
}

function zapRow(ev: NostrEvent, profiles: ProfileMap): SafeHtml {
    const { sender, sats } = parseZapReceipt(ev);
    const time = html`<span class="time">· ${timeAgo(ev.created_at)}</span>`;
    if (!sender) return html`<li class="notif-row"><div class="notif-text">⚡ someone zapped you ${sats} sats ${time}</div></li>`;
    return html`<li class="notif-row">${avatar(sender, profiles.get(sender)?.picture, 'sm')}
        <div class="notif-text">${profileLink(sender, profiles)} zapped you ${sats} sats ${time}</div></li>`;
}

function pollvoteRow(ev: NostrEvent, profiles: ProfileMap): SafeHtml {
    const pollId = ev.tags.find((t) => t[0] === 'e' && t[1])?.[1];
    let poll: SafeHtml = html`your poll`;
    if (pollId) { try { poll = html`<a href="/t/${neventEncode({ id: pollId })}" h-scroll="top instant">your poll</a>`; } catch { /* keep text */ } }
    return html`<li class="notif-row">${avatar(ev.pubkey, profiles.get(ev.pubkey)?.picture, 'sm')}
        <div class="notif-text">${profileLink(ev.pubkey, profiles)} voted on ${poll} <span class="time">· ${timeAgo(ev.created_at)}</span></div></li>`;
}

function reactionRow(ev: NostrEvent, profiles: ProfileMap): SafeHtml {
    const noteId = [...ev.tags].reverse().find((t) => t[0] === 'e' && t[1])?.[1]; // the reacted note
    // A custom (NIP-30) reaction is a `:shortcode:` in content + the image in this event's own `emoji`
    // tags - decode against those (not the reactor's profile). A "+"/empty like normalizes to a heart.
    const react = ev.content === '+' || ev.content === '' ? html`♥` : withEmoji(ev.content, emojiFromTags(ev.tags));
    let note: SafeHtml = html`your note`;
    if (noteId) { try { note = html`<a href="/t/${neventEncode({ id: noteId })}" h-scroll="top instant">your note</a>`; } catch { /* keep text */ } }
    return html`<li class="notif-row">${avatar(ev.pubkey, profiles.get(ev.pubkey)?.picture, 'sm')}
        <div class="notif-text">${profileLink(ev.pubkey, profiles)} reacted ${react} to ${note} <span class="time">· ${timeAgo(ev.created_at)}</span></div></li>`;
}

/** A private (gift-wrapped) reply to one of your notes: author + a lock + the reply text, linking to the
 * PARENT note's thread (where it shows inline). The reply itself has no public thread of its own, so we
 * never link to it - we point back to the note it answers. */
function privateReplyRow(ev: NostrEvent, profiles: ProfileMap): SafeHtml {
    const parentId = replyParent(ev)?.id;
    let note: SafeHtml = html`your note`;
    if (parentId) { try { note = html`<a href="/t/${neventEncode({ id: parentId })}" h-scroll="top instant">your note</a>`; } catch { /* keep text */ } }
    return html`<li class="notif-row notif-private">${avatar(ev.pubkey, profiles.get(ev.pubkey)?.picture, 'sm')}
        <div class="notif-text">${profileLink(ev.pubkey, profiles)} replied privately <span class="private-mark">${icon('lock')}<span class="sr-only">private</span></span> to ${note} <span class="time">· ${timeAgo(ev.created_at)}</span>
        <div class="notif-quote">${ev.content}</div></div></li>`;
}

function notifRow(n: Notif, profiles: ProfileMap, s: Session): SafeHtml {
    if (n.type === 'reply' || n.type === 'mention') return noteCard(n.event, profiles, s, { mute: true });
    if (n.type === 'zap') return zapRow(n.event, profiles);
    if (n.type === 'reaction') return reactionRow(n.event, profiles);
    if (n.type === 'privateReply') return privateReplyRow(n.event, profiles);
    return pollvoteRow(n.event, profiles);
}

/** A run of notification rows (newest-first). The route decides where the new→seen boundary
 * and pager fall; this just renders the rows it's handed. */
export function notifList(items: Notif[], profiles: ProfileMap, s: Session): SafeHtml {
    return html`${items.map((n) => notifRow(n, profiles, s))}`;
}
