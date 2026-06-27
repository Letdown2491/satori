# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/Letdown2491/satori/releases/tag/v0.1.0
