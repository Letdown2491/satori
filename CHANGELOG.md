# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-29

### Added

- NIP-22 comments (kind 1111) now render as a proper comment card - the comment body
  (reusing the note content pipeline) with an "in reply to <parent>" link to whatever
  it comments on - instead of an "unsupported kind" fallback. Applies wherever a
  comment is encountered (a quoted/embedded reference, or viewing one directly).
  Previously Satori only understood kind 1111 as the comment thread under an article.
- NIP-22 comments are now folded into note and picture threads: opening a note's (or
  picture's) thread shows kind:1111 comments alongside the kind:1 replies, nested by
  their NIP-22 parent. (See "Replies now follow NIP-22 on the write side" below for what
  Satori posts when you reply.)
- Per-post relay targeting: a "Relays" button (globe) in the note composer, next to
  Schedule, reveals your NIP-65 write relays as toggle chips - all selected by default
  - plus a one-off "wss://…" field, so you can post a single note to a chosen subset
  instead of broadcasting to every write relay. The picker resets to all-selected each
  time you compose, an empty selection still posts to all your write relays (never to
  nowhere), only relays in your own write set are honored, and a custom relay is
  validated (private/loopback hosts rejected). Works in both signing modes. Notes only
  for now; polls and articles still post to all write relays.
- Relay timelines: browse any relay's feed directly. The feed switcher's "Browse a
  relay…" opens a picker where you type any relay URL (or pick a favorite / one of your
  own relays); while viewing a relay you can star it to favorite it for quick re-entry.
  It's all inline - nothing in settings. Each relay opens a chronological timeline at
  `/relay?r=…`, a plain infinite-scroll feed that reuses the existing machinery (your
  per-kind visibility prefs, mutes, content filters, and Privacy Mode/Tor routing all
  apply). Favorites are stored on this server only; relay URLs are validated and
  private/loopback hosts are rejected.

### Changed

- People search dropped `nostr.wine` from its default relay set (it appears effectively dead); it
  now defaults to relay.ditto.pub, relay.vertexlab.io, and antiprimal.net. A custom search-relay
  list you set in Settings is unchanged.
- Settings cleanup: the Media servers editor (your Blossom upload hosts) moved out of the Relays
  tab into Appearance & Behavior, next to the other media settings - media servers aren't relays.
  Relay trust assertions are now always on (the per-user toggle was removed and is no longer needed);
  an operator can still disable the feature instance-wide by setting `SATORI_TRUST_PROVIDER` empty.
- Quote reposts can now be scheduled too: the quote composer gained the same clock "Schedule"
  control as notes (a quote is a top-level post to your write relays, so it schedules like one;
  replies still can't, being thread-bound). Photo/video and content-warning were already there.
- Scheduling now works for articles, not just notes. The article composer gained the same clock
  "Schedule" control: pick a future time and the daemon signs it now and broadcasts it at that
  moment, even with your browser closed. Cancelling a queued post (note or article) reverts it to an
  editable draft - an article keeps its slug so re-publishing updates the same piece. Both signing
  modes. (Polls aren't schedulable: a poll's end date is fixed when it's signed, so holding it for a
  later send would make the countdown start from compose time.) The schedule control's revealed row
  is also tidier across both composers - a "Publish on" label, an accent Schedule button, and a
  legible datetime picker on the dark theme.
- Replies now follow NIP-22 on the write side: replying to a kind:1 note still posts a kind:1
  NIP-10 reply (the spec requires this - "Comments MUST NOT be used to reply to kind 1 notes"),
  but replying to anything else - an existing comment, a picture (kind 20), or a video (kind
  21/22) - now posts a proper kind:1111 comment instead of a kind:1. A reply to a comment
  inherits that comment's root scope so it nests correctly; a reply to a picture/video is a
  top-level comment on it. This makes your replies thread properly in clients that use NIP-22
  comments (picture/video apps), where a kind:1 reply would not have shown as a comment at all.
  Works in both signing modes; the parent's kind rides along in the reply's `nevent` so the
  common note-reply path needs no extra lookup.
- Quote posts now carry a relay hint on their NIP-18 `q` tag (and a read-relay hint on
  the quoted author's `p` tag), resolved from the quoted author's NIP-65 write relay the
  same way replies already do. Previously the hint was blank, so a client rendering the
  quote had to fall back to a relay-list lookup to find the quoted note; now the quote is
  self-resolving. Behavior is unchanged when the quote already carried a hint.
- The wallet page now hides the WebLN payment method entirely when no WebLN extension
  is detected, instead of showing it with a disabled "Not detected" badge. It's
  capability-based (revealed the moment `window.webln` is present), so an installed
  extension still surfaces it - including the rare mobile browser that has one - while
  the common no-extension case (most mobile) just shows NWC.
- NIP-22 comments (kind 1111) now appear in timelines, on profiles, and in
  notifications alongside kind:1 replies - a comment is the NIP-22 equivalent of a
  reply, so it's fetched with notes and shown by default, and a comment on your post
  now lights the notifications bell. The "hide replies" setting now governs both reply
  forms (it previously only matched NIP-10 replies). The standalone "Comments" content
  toggle was removed in favor of this replies model.
- Empty timelines now use the same calm "clearing" look as the notifications page - a
  contemplative line in quotation marks over the ensō seal - instead of the old
  ensō-over-a-plain-line. Applies to the feed tabs and profile timelines (the Following
  feed already used this look).
- Conversation faces (the reply-presence avatars) now appear reliably across every
  timeline (Following, Followers, The Commons, Longform, relay timelines) and on
  profiles, not just the frequently-visited Following feed. They hydrate lazily after
  paint via a small background request, so there's no added first-paint latency - and
  they now also show under Privacy Mode (Tor), where they previously almost never did.
- The NIP-46 (bunker) connect request now sends fuller client metadata - `name`, the
  project `url`, and an `image` (the ensō icon) - so the remote signer's approval
  screen can show Satori's name and icon, not just the name.
- The "caught up" clearing (feed + notifications) now reaches older history through an
  explicit "View older posts" / "View older notifications" text link, instead of a
  hidden tappable ensō that people didn't realize they could click. A smaller ensō
  seal sits just below the link as the closing mark (and stands alone, full size, in
  the terminal state when there is nothing more to load). The "You're all caught up."
  caption was dropped - the contemplative line and the seal already convey it - and
  that line now reads inside quotation marks.
- The left header button is now a Home button (house icon, labeled "Home") instead
  of the "Notes" button, which people read as a notes feature rather than "go to your
  timeline". Behavior is unchanged: it still links to your timeline and carries the
  new-notes dot.
- `styles.css` is now minified on the fly before gzip (comments stripped, whitespace
  collapsed), cutting the gzipped stylesheet roughly in half (~35KB to ~17KB). The
  minify is string-safe and conservative (it leaves `calc()` spacing and descendant
  selectors intact), runs CSS-only (the served JS is already minified), and is cached
  by file mtime, so the source stays readable and live-editing still works with no
  build step.

### Fixed

- The Messages screen no longer mixes conversations across accounts on the browser-extension
  (NIP-07) signing path. The decrypted-DM cache is process-global, and the NIP-07 conversation
  list wasn't scoped to the active account - so a daemon used by more than one npub (your own
  multiple identities, or a trusted multi-user instance) showed every account's conversations in
  one undifferentiated list. Each NIP-07 cache entry is now stamped with the account that decrypted
  it, and every read filters to the active account - matching the isolation the bunker path already
  had. (On a multi-user instance this also closes a cross-user DM exposure on the NIP-07 path.)

## [0.2.0] - 2026-06-27

### Added

- Nostr Wallet Connect (NIP-47) as a browser-side zap payment method alongside WebLN.
  The connection string is held only in the browser and is never sent to the daemon;
  nip04/nip44 encryption is negotiated from the wallet's info event; `pay_invoice` and
  `get_balance` are supported. When both WebLN and NWC are connected, you explicitly
  choose which one pays your zaps (no silent default).
- A redesigned wallet page: one "Payment method" card presenting WebLN and NWC as
  peers, each a selectable card when both are connected, with a labeled NWC balance.

### Changed

- Posting a top-level note or poll from the timeline now stays put instead of
  re-rendering the feed (which could bounce you to the "caught up" boundary). Posting
  from the full compose page still lands on the feed.
- CSP `connect-src` now permits `wss:` for the browser's NWC wallet socket.
- hext.js updated to 0.2.0 (NIP-07 signing, WebLN, and NWC over hypermedia).

### Fixed

- The "Sign in with extension" button is now hidden unless a NIP-07 extension is
  detected, instead of always showing a dead button.
- An empty-timeline glitch after posting, where a mark-seen could advance the feed
  boundary mid-render and blank the timeline.

## [0.1.0] - 2026-06-27

First public release: a complete, server-rendered hypermedia (HATEOAS) nostr client
with a zero-JS baseline.

### Core

- NIP-46 bunker and NIP-07 extension sign-in; the signing key never touches the server.
- NIP-65 outbox routing across Following / Followers / Commons / Longform feeds, with
  infinite scroll, a live "new notes" indicator, and a "caught up" boundary.
- Profiles (pinned + articles strips, kind:0 editor), threads, and NIP-22 comments.
- Rich compose: notes, replies, quotes, content warnings, polls, media upload, and
  `@`-mention / `:`emoji autocomplete.
- Optimistic UI for like / bookmark / pin / follow / mute / poll-vote, reconciled
  against the server and rolled back on failure.

### Content kinds

- NIP-23 long-form (reader + composer), NIP-68 pictures, NIP-71 video (with an optional
  load-inline toggle), NIP-52 calendar events (RSVP + `.ics` export), NIP-99
  classifieds, podcasts, and NIP-84 highlights (rendered via a declarative card engine
  with hand-coded handlers where a kind earns one).
- Media galleries, a pure-CSS full-screen lightbox, NIP-36 content-warning blur, and a
  privacy-preserving image proxy with NIP-B7 healing (a dead Blossom link is recovered
  from the author's other servers, SHA-256 verified).

### Messaging and discovery

- Private DMs (NIP-17 gift wrap), for both signing modes.
- NIP-50 search (people + notes), live as-you-type, with rich operators.
- Notifications with an unread bell; drafts (local + NIP-37 cross-device sync);
  bookmarks, follows, mutes (with feed/thread/notification filtering).

### Zaps and wallet

- NIP-57 zaps via Lightning invoice or WebLN one-tap, with `:`emoji in the zap message.
- A no-custody wallet view (no spending key is ever stored).

### Privacy and infrastructure

- Server-wide Tor privacy mode (off / balanced / strict) and `.onion` relays over Tor.
- Relay trust assertions read from nostr (kind:30385), with no third-party API call.
- NIP-42 relay AUTH for bunker sessions.
- Scheduled posts and server-side content filters.
- An undo window that holds a signed event before publishing.
- Self-hostable as a single-user daemon, with owner-locked access control and an
  optional Tor hidden service.

[0.2.1]: https://github.com/Letdown2491/satori/releases/tag/v0.2.1
[0.2.0]: https://github.com/Letdown2491/satori/releases/tag/v0.2.0
[0.1.0]: https://github.com/Letdown2491/satori/releases/tag/v0.1.0
