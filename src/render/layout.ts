// The base page shell, in Satori's Sumi-e chrome. `<body h-boost>` upgrades every
// plain <a>/<form> to helmjs partial-swap + push-URL navigation with no per-element
// attributes - and the dropdowns are native <details>, so the whole chrome works
// with JS off. data-theme is set server-side from the appearance cookie (no flash).

import { html, raw, type SafeHtml } from '../html.ts';
import { enso, icon, ENSO_DEFS } from './svg.ts';
import { avatar } from './util.ts';
import { privacyMode } from '../privacy.ts';
import type { Theme } from '../theme.ts';

export interface Me { npub: string; hex: string; name: string; picture?: string }

export type ActiveView =
    | 'feed' | 'profile' | 'compose' | 'notifications' | 'bookmarks'
    | 'settings' | 'wallet' | 'drafts' | 'muted' | 'search' | null;

export type FeedTab = 'following' | 'followers' | 'commons' | 'longform';

export interface ChromeOpts {
    title?: string;
    loggedIn: boolean;
    me?: Me;
    active?: ActiveView;
    feedTab?: FeedTab;
    /** Newest note timestamp on a feed tab - anchors the bar's "notes" poller. */
    notesSince?: number;
    /** When set, this is a relay timeline: the switcher shows this label as current (no tab active). */
    relayLabel?: string;
    theme?: Theme;
    /** Content already renders its own <h1> (e.g. the article reader) - suppress the
     * injected sr-only page heading so there's exactly one h1. */
    contentH1?: boolean;
}

/** The poller h-trigger string. On first mount (`initial`) it carries `load` for a one-shot check;
 * the re-arm response omits it (else load → swap → load → … loops), keeping just the interval. */
const pollTrigger = (everyS: number, initial: boolean): string =>
    initial ? `load, every ${everyS}s visible` : `every ${everyS}s visible`;

const FEED_TABS: { tab: FeedTab; label: string; href: string }[] = [
    { tab: 'following', label: 'Following', href: '/' },
    { tab: 'followers', label: 'Followers', href: '/followers' },
    { tab: 'longform', label: 'Longform', href: '/longform' },
    { tab: 'commons', label: 'The Commons', href: '/commons' },
];


/** The notifications bell with a quiet unread dot. A poller (load + every 90s)
 * re-checks /notifications/unread and outer-swaps this with the lit/quiet version.
 * h-push-url="false" so the background probe never touches the address bar. */
export function notifBell(unread = false, initial = false): SafeHtml {
    // `load` does the one-shot check when the bell first mounts (page load / nav). The
    // re-arm response from /notifications/unread must NOT carry it (initial=false) -
    // otherwise each response re-fires load → /unread → swap → load → … (an infinite
    // poll loop that hammers the server and races boosted navigations). Re-arm just
    // keeps the 90s interval.
    const trigger = pollTrigger(90, initial);
    const poll = html`<span class="notif-poll" h-get="/notifications/unread" h-trigger="${trigger}" h-target="#notif-bell" h-swap="outer" h-push-url="false"></span>`;
    return html`<a id="notif-bell" class="notif-bell ${unread ? 'has-new' : ''}" href="/notifications" title="Notifications" aria-label="Notifications" h-scroll="top instant">${icon('bell')}${unread ? html`<span class="notif-dot"></span>` : null}${poll}</a>`;
}

/** The quiet DM unread dot riding on the account avatar (the Messages entry lives in
 * the dropdown). A poller re-checks /messages/dot; lights when there are wraps we
 * haven't processed. No count - same calm language as the notification dot. nip07 gets
 * no dot (DMs are bunker-only); the poller just no-ops there. */
export function dmDotInner(unread = false, initial = false): SafeHtml {
    const trigger = pollTrigger(90, initial);
    const poll = html`<span class="dm-poll" h-get="/messages/dot" h-trigger="${trigger}" h-target="#dm-dot" h-swap="inner" h-push-url="false"></span>`;
    return html`${unread ? html`<span class="notif-dot dm-dot-mark"></span>` : null}${poll}`;
}

/** The centered feed switcher - a native <details> dropdown (zero-JS). The four built-in feeds, then
 * "Browse a relay…" which opens the relay picker modal (type any relay / pick a favorite). On a relay view
 * `relayLabel` is the current label (no tab highlighted). The pick link carries the current tab/label so the
 * picker response can OOB this <details> back CLOSED (`oob`) - opening a modal is a partial swap, so the
 * native dropdown would otherwise stay open behind it. The switcher's markup is fully (tab, label)-derived. */
export function feedSwitch(active: FeedTab, relayLabel?: string, oob = false): SafeHtml {
    const currentLabel = relayLabel ?? (FEED_TABS.find((t) => t.tab === active) ?? FEED_TABS[0]!).label;
    const pickHref = `/relay/pick?tab=${active}${relayLabel ? `&rl=${encodeURIComponent(relayLabel)}` : ''}`;
    return html`
      <details id="feed-switch"${oob ? raw(' h-oob="true"') : raw('')} class="feed-switch">
        <summary class="feed-toggle"><span>${currentLabel}</span> <span class="chevron">▾</span></summary>
        <div class="feed-menu">
          ${FEED_TABS.map((t) => html`<a class="feed-item ${!relayLabel && t.tab === active ? 'active' : ''}" href="${t.href}" h-get h-prefetch="hover" h-scroll="top instant">${t.label}</a>`)}
          <a class="feed-item feed-item-add" href="${pickHref}" h-target="#modal" h-swap="inner" h-focus="#relay-pick-url" h-push-url="false">Browse a relay…</a>
        </div>
      </details>`;
}

/** The right-hand account hub - avatar + native <details> dropdown menu. When Privacy
 * Mode is on, the avatar itself BECOMES the shield (one element reflecting state, no
 * extra bar icon, hover title shows the mode); your face stays in the menu head. The
 * mode is set/seen in Settings > Privacy - nothing else clutters the menu. */
export function accountMenu(me: Me, oob = false): SafeHtml {
    const pmode = privacyMode();
    const onTor = pmode !== 'off';
    const modeLabel = pmode.charAt(0).toUpperCase() + pmode.slice(1);
    const face = onTor
        ? html`<span class="avatar-ring tor" title="Privacy Mode: ${modeLabel}"><span class="avatar-shield">${icon('shield')}</span></span>`
        : avatar(me.hex, me.picture, 'sm');
    // id="account-hub" so a Privacy Mode toggle can OOB-swap the hub (avatar ↔ shield)
    // live, without a full reload.
    return html`
      <details class="menu-wrap" id="account-hub"${oob ? raw(' h-oob="true"') : raw('')}>
        <summary class="avatar-btn" aria-label="${onTor ? `Account, Privacy Mode ${modeLabel}` : 'Account'}">${face}</summary>
        <div class="menu menu-right">
          <!-- The head doubles as the Profile link (the standalone "Profile" item is retired).
               Menu links prefetch on hover (h-get + h-prefetch) - only hoverable while the menu is
               open, so it's high-intent, no stray prefetching. -->
          <a class="menu-head" href="/u/${me.npub}" h-get h-prefetch="hover" h-scroll="top instant">
            ${avatar(me.hex, me.picture, 'sm')}
            <div class="menu-id">
              <span class="me-name">${me.name}</span>
              <span class="copy-npub">${me.npub.slice(0, 16)}…</span>
            </div>
          </a>
          <a class="menu-item neutral" href="/bookmarks" h-get h-prefetch="hover" h-scroll="top instant">Bookmarks</a>
          <a class="menu-item neutral" href="/drafts" h-get h-prefetch="hover" h-scroll="top instant">Drafts</a>
          <a class="menu-item neutral" href="/messages" h-get h-prefetch="hover" h-scroll="top instant">Messages</a>
          <a class="menu-item neutral" href="/muted" h-get h-prefetch="hover" h-scroll="top instant">Muted</a>
          <a class="menu-item neutral" href="/notifications" h-get h-prefetch="hover" h-scroll="top instant">Notifications</a>
          <a class="menu-item neutral" href="/settings" h-get h-prefetch="hover" h-scroll="top instant">Settings</a>
          <a class="menu-item neutral" href="/wallet" h-get h-prefetch="hover" h-scroll="top instant">Wallet</a>
          <form class="logout-form" action="/logout" method="post">
            <button type="submit" class="menu-item">Log out</button>
          </form>
        </div>
      </details>`;
}

/** The Home button - a link to your timeline - used in the left slot off the feed
 * (one button, no separate Notes/Home split). Shown with a house icon and labeled
 * "Home" so it reads as "go to your timeline", not a notes feature. It polls
 * /notes/dot so the new-notes dot lights up from anywhere (the ambient signal), and
 * re-arms by outer-swapping #notes-home. (The id/class/route keep the `notes-` name
 * internally - they're not user-visible and drive the dot poller.) */
export function notesHome(hasNew = false, initial = false, oob = false): SafeHtml {
    // `load` only on first mount; the /notes/dot re-arm omits it, else load → /notes/dot
    // → swap → load → … loops (same fix as the notif bell). `oob` lets /feed/seen swap this in
    // out-of-band (by id) to clear the dot the moment you reach the "caught up" ensō.
    const poll = html`<span class="notes-poll" h-get="/notes/dot" h-trigger="${pollTrigger(60, initial)}" h-target="#notes-home" h-swap="outer" h-push-url="false"></span>`;
    return html`<a id="notes-home"${oob ? raw(' h-oob="true"') : raw('')} class="notes-mark ${hasNew ? 'has-new' : ''}" href="/" title="Home" aria-label="Home" h-get h-prefetch="hover" h-scroll="top instant">${icon('home')}${hasNew ? html`<span class="notif-dot"></span>` : null}${poll}</a>`;
}

function bar(o: ChromeOpts): SafeHtml {
    if (!o.me) return html``;
    const onFeed = o.active === 'feed';
    // The left slot is ALWAYS the Home → Following link (with the new-notes dot, polled from
    // /notes/dot). So it's a predictable Home button everywhere - never a dead click - rather
    // than the old per-tab "load new notes" control that sat inert when there was nothing new.
    // The title is a location label, not the page's heading (the real <h1> lives in <main>).
    const left = html`<nav class="bar-left" aria-label="Primary">${notesHome(false, true)}${notifBell(false, true)}</nav>`;
    const center = onFeed
        ? html`<div class="header-center">${feedSwitch(o.feedTab ?? 'following', o.relayLabel)}</div>`
        : html`<div class="header-center"><span class="page-title">${o.title ?? ''}</span></div>`;
    // Search + the account hub. The avatar itself becomes the privacy shield when Tor
    // is on (in accountMenu), so no separate indicator crowds the bar.
    const right = html`<nav class="bar-right" aria-label="Account"><a class="notes-mark" href="/search" aria-label="Search" h-focus="#search-input" h-scroll="top instant">${icon('search')}</a>${accountMenu(o.me)}</nav>`;
    return html`<header class="bar">${left}${center}${right}</header>`;
}

/** Wrap rendered body content in the full HTML document. */
export function page(content: SafeHtml, o: ChromeOpts): SafeHtml {
    const title = o.title ? `${o.title} · Satori` : 'Satori';
    const theme = o.theme ?? 'sumi-e';
    // One injected sr-only <h1> per page (the document heading), unless the content
    // already supplies one (the article reader). Feed has no chrome title → use the
    // active tab's label.
    const h1text = o.title ?? (o.active === 'feed' ? (FEED_TABS.find((t) => t.tab === o.feedTab)?.label ?? 'Home') : 'Home');
    const pageHeading = o.contentH1 ? null : html`<h1 class="sr-only">${h1text}</h1>`;
    const shell = o.loggedIn
        ? html`
          <a class="skip-link" href="#viewport">Skip to content</a>
          <div id="app">
            ${bar(o)}
            <main id="viewport" tabindex="-1">
              ${pageHeading}
              <div h-error class="error-region" role="alert" aria-live="polite"></div>
              ${content}
            </main>
          </div>
          <div class="fab-wrap"><a class="fab" href="/compose" aria-label="New note" h-target="#modal" h-swap="inner" h-focus="#compose-text">+</a></div>
          <a class="scroll-top" href="#app" aria-label="Jump to top">↑</a>
          <div id="modal"></div>`
        : html`
          <div id="app">
            <div h-error class="error-region" role="alert" aria-live="polite"></div>
            ${content}
          </div>`;
    return html`<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%23b23a26' stroke-width='2.4'/%3E%3C/svg%3E">
  <script src="/helm.js" defer></script>
  <script type="module" src="/hext.js"></script>
</head>
<body h-boost>
  ${ENSO_DEFS}
  <!-- Global loading bar, driven purely by helmjs' data-h-busy on <html> (set
       while a foreground request is in flight; outside #viewport so it stays crisp
       while the content ink-blurs). -->
  <div id="nav-progress" aria-hidden="true"></div>
  ${shell}
  <!-- In-flight indicators, revealed purely by CSS while hateoas-extensions has set
       <html data-nostr-busy> (signing) / <html data-webln-busy> (WebLN payment).
       The extension-prompt + resubmit window; no app JS. -->
  <!-- Two-phase signing toast: "awaiting" = waiting for the signer to respond; "resubmitting" =
       it responded, the signed result is going back to the server. Toggled CSS-only off hext.js'
       data-nostr-busy phase on <html>. Generic copy (the toast covers all signing, not just login). -->
  <div class="toast signing-toast" role="status" aria-live="polite">
    <span class="sign-await">Waiting for your signer…</span>
    <span class="sign-work">Finishing up…</span>
  </div>
  <!-- Two-phase WebLN toast: "awaiting" = waiting for wallet confirmation; "paying" = confirmed,
       the payment is in flight. Same CSS-only phase toggle off data-webln-busy. -->
  <div class="toast paying-toast" role="status" aria-live="polite">
    <span class="pay-await">Approve the payment in your wallet…</span>
    <span class="pay-work">Sending payment…</span>
  </div>
  <!-- Mount for the post-publish undo toast: a top-level note/poll floats its countdown here (retargeted
       to #undo-slot) instead of re-rendering the feed, so posting from the timeline leaves it untouched. -->
  <div id="undo-slot"></div>
</body>
</html>`;
}

/** The Satori wordmark (ensō + name) - used on the sign-in screen. Matches the
 * SPA: an <h1 class="wordmark"> with the ensō and the accent "Satori". */
export function wordmark(): SafeHtml {
    return html`<h1 class="wordmark">${enso(60)}<span class="accent">Satori</span></h1>`;
}
