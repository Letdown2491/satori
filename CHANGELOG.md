# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/Letdown2491/satori/releases/tag/v0.2.0
[0.1.0]: https://github.com/Letdown2491/satori/releases/tag/v0.1.0
