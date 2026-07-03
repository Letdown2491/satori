# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Custom timelines. Any content type in Settings > Content can be given its own entry in the header
  switcher, showing that type from the people you follow. So you can, for example, keep Pictures out of
  your main feed but still have a Pictures timeline, or add a Custom NIPs timeline. It's the third
  checkbox ("Own timeline") next to Feeds and Profile. Articles is on by default, which is the old
  Longform tab, now just one of these timelines.

### Changed

- Renamed the "Appearance & Behavior" settings tab to "General".
- Each Settings tab now has its own URL (`/settings/relays`, and so on), so a reload keeps you on the tab
  you were on and you can bookmark or link straight to one. Before, every tab lived at `/settings` and a
  reload snapped back to General.
- Settings > Content is easier to use. The content-type toggles now save the moment you flip them (with a
  quiet "Saved ✓"), so there's no Save button to hunt for; the keyword/regex filter keeps its own Save, since
  you don't want that saved mid-typing. The type list shows the common types (Notes, Polls, Articles,
  Pictures, Videos) with the niche kinds behind a "Show more" toggle, so it stays compact as more are added.
- Minor visual polish across the settings tabs (tidier button sizing, a clearer "Show more" toggle).

### Fixed

- Recipes and other gated posts no longer show up as podcasts. Kind 54 is used both for podcast episodes
  and, in the wild, for lightning-gated content with no audio (zap.cooking recipes and the like), so a
  Podcasts timeline or feed could surface a recipe rendered as a playerless podcast. A kind:54 event is now
  treated as a podcast only if it actually has an audio track; the rest are dropped from feeds, timelines,
  profiles, and relay browsing.

## [0.5.0] - 2026-07-04

### Added

- Per-post relay targeting on the Poll, Article, and Picture composers, matching Notes. A
  globe toggle reveals your write relays as chips (all checked by default) plus a one-off
  "wss://…" field, so you can send a post to a chosen subset of relays instead of all of
  them. Empty selection still means all your write relays (never nowhere). Works on both
  signing families (extension and bunker).
- Scheduling on the Picture composer: pick a future time and the daemon broadcasts the
  picture then, even with your browser closed, via the same sweep that already handles
  scheduled notes and articles. (Polls stay non-schedulable by design: a poll's end time is
  baked in when it's signed, so a scheduled poll would arrive already counting down.)
- A page `<meta name="description">`.
- A `feedRecovery` counter at the login-gated `GET /metrics` (landings, notes surfaced, notes
  recovered by the slow-relay backfill, and the recovery rate) so the feed-reliability work can be
  measured and tuned on real numbers instead of estimates.

### Changed (defaults)

- "Load nostr videos inline" now defaults ON, so the timeline shows real video frames out of
  the box (a first-frame fetch to the video host, no different from any media load). Turn it
  off in Settings to keep the no-fetch play facade. YouTube is unaffected (always its own
  facade), and Strict privacy mode still suppresses video regardless.

### Changed

- The following feed is faster to first paint and more complete on slow connections. The
  landing now paints on a tight deadline (whatever the fast relays return), while the
  off-feed new-notes poll searches harder, on an adaptive per-relay timeout learned from how
  each relay actually responds, and folds any slow-relay notes it catches into a buffer that
  the "N new notes" indicator counts and the feed then renders. So a followed author whose
  notes live on a slow or laggy relay surfaces within seconds instead of being dropped, and
  the indicator can no longer promise notes the feed then fails to load. Observation-only
  groundwork for this shipped in 0.4.2; this turns it on. The per-relay timeouts self-calibrate
  to how each relay actually behaves - notably, they now bail out fast on relays that
  consistently deliver nothing for your feed instead of waiting on them - and keep adapting as
  your follows move relays around.
- Compose UI consistency across all four composers: the action bars are now a matching
  rounded card; the schedule and relay-picker sections carry their own panel background so
  they look the same in the in-feed modal and on the full `/compose` page; the type pills
  (Note · Picture · Poll · Article) get consistent spacing off the first field; and the
  Article composer's section spacing, button order, and foot now match the other tabs. The
  Article schedule (clock) icon also picks up the same muted color as the others.
- Bumped the bundled helmjs to v0.14.4. No API changes, all passive hardening we benefit from:
  a fix for `h-sync="abort"` letting two concurrent requests slip through (helps search-as-you-type
  and the feed poll), an `IntersectionObserver` leak fix for non-`once` intersect triggers, and a
  bound (cap 50) on the `h-prefetch` speculative cache. Its new security note (untrusted HTML in a
  swap can smuggle live `h-*` directives) does not affect us: all rendered content goes through the
  `SafeHtml` escaping helper and the markdown/asciidoc parsers honor no raw-HTML passthrough, so
  user content can never become a live element.

### Fixed

- Zap notifications are now validated instead of trusted. A kind:9735 receipt's zapper name and sats
  come from an embedded zap request that anyone can forge in a receipt addressed to you, so a fake
  "Jack zapped you 1,000,000 sats" was possible. The embedded request's signature is now verified and
  its target checked against the receipt; the amount is taken from the paid invoice (authoritative). An
  unverifiable zap shows as an anonymous "someone zapped you N sats" with the real amount, never a
  spoofed name. (Found in a NIP-57 read-side audit.)
- Trailing punctuation after a link no longer becomes part of the link. A URL written with normal
  punctuation, e.g. `https://nostr21.com,` or `(https://nostr21.com)`, was linked including the comma or
  paren, so clicking it went to the wrong address; the trailing characters now stay as text. Balanced parens
  inside a URL (e.g. a Wikipedia `..._(disambiguation)` link) are preserved. Applies to notes and article
  bodies (markdown + asciidoc).
- A `nostr:nsec…` (or other non-standard `nostr:` entity) pasted or quoted in a note's content is no longer
  turned into a clickable link. Previously the raw bech went into an `href` to njump.me, so an nsec (a private
  key) could be leaked to a third party on click; it now renders inert, and secret types are redacted rather
  than echoed. (Found in a NIP-21 read-side audit.)
- Edited articles (and other addressable events) no longer show twice in the longform feed or on profiles. The
  outbox fan-out merges events from multiple relays, so a stale copy and the edited copy - different event ids,
  same `d` coordinate - were both kept; addressable kinds now collapse by their (kind, author, d) coordinate,
  keeping only the newest, per NIP-01. (Found in a NIP-01 read-side audit.)
- Reply cards ("in reply to an earlier note") now resolve the parent more often. NIP-10 replies weren't
  passing the parent's author to the embed resolver, so a reply whose `e` tag had no relay hint could only be
  searched on your own relays and often failed to fill in. It now includes the parent author (so the resolver
  can use their outbox/write relays), matching how NIP-22 comment parents already resolved.
- The relay-favorite star and the Undo buttons work again. The helmjs 0.14.2 bump (in 0.4.2) had regressed
  `h-post` on bare buttons - it only bound the mutating verbs on `<form>` elements - which silently disabled
  every form-less mutation. Fixed in helmjs 0.14.3 (mutating verbs now bind on any element, like `h-get`
  already did) and re-bundled.
- Extensionless media (a Blossom hash URL) in a note now renders as the image/video it is instead of a plain
  text link. The content tokenizer classifies media by file extension, so a URL with no extension was missed;
  it now also honors the NIP-92 `imeta` `m` (mime) type, so such media groups into galleries and gets a
  lightbox like any other. (Found in a NIP-92 read-side audit.)
- Vertical short videos (NIP-71 kind 22 / 34236) with no `dim` in their `imeta` now render in portrait
  instead of defaulting to landscape - the video kind is used as the orientation fallback.
- Article topics (NIP-23 `t` tags) are now shown on the article reader as a row of hashtag chips, each
  linking to a search for that tag. They were parsed but never displayed.
- Dislike reactions (NIP-25 `-`) are no longer surfaced in notifications at all. A stranger's thumbs-down
  carries no reply/zap/conversation value and is pure agitation, so omitting it is consistent with hiding the
  like button and reaction counts. Positive and custom-emoji reactions still show (when reaction notifications
  are enabled, which is off by default).
- The thread "root" link for old, unmarked (deprecated positional NIP-10) replies now points at the true
  thread root (the first `e` tag) rather than the immediate parent.
- A `nostr:`-prefixed reference is no longer tokenized when it sits mid-word (e.g. `foonostr:...`), matching
  the existing guard on bare `npub1...`/`note1...` references; and a NIP-22 comment that quotes an event no
  longer risks mistaking that `q`-quoted event for its parent. (Found in NIP-27 / NIP-22 read-side audits.)

### Security

Isolation fixes that matter when more than one account uses the same instance, and groundwork for
multi-tenancy:

- Undo-window tokens are now tied to the session. A pending (about-to-publish) note can only be read
  or cancelled by the account that created it, not by anyone else who holds its token.
- Logging out clears only your own cached data. It used to wipe every signed-in account's decrypted-DM
  and emoji caches; it now leaves other accounts' caches alone and rewrites the on-disk DM cache without
  your messages.
- `GET /metrics` is restricted to the instance owner. Its instance-wide counters were readable by any
  logged-in user; now only the owner (`SATORI_OWNER`, or whoever first claimed the instance) can see them.

## [0.4.2] - 2026-07-02

### Added

- Per-relay latency profiling (observation only, no behavior change): Satori now records how quickly each
  relay responds to the feed queries it already runs, into a small persisted profile (`.data/relay-latency.json`,
  override with `SATORI_RELAY_LATENCY_FILE`). Nothing uses it yet; it's the groundwork for adaptive per-relay
  timeouts, so a relay that's genuinely slow can be given more time without slowing the fast majority (which
  will make following feeds more complete on slow connections/hosts). Set `SATORI_REQ_LOG=1` to see the
  per-relay timings in the logs.

### Removed

- Removed "The Commons" timeline. It was a curated trending feed backed by a single hardcoded external
  relay (`feeds.nostrarchives.com`), which ran against the goal of not hardcoding relays; it also
  wasn't pulling its weight. The tab, its route (`/commons`), the trending fetch, its cached page, and
  its empty-state quote are all gone. Following, Followers, and Longform are unaffected.

### Changed

- The header title is now a dropdown on every page, not just the timelines. On a timeline it's the same
  tab switcher as before; on any other page (Drafts, Bookmarks, Muted, Settings, a profile, an article,
  etc.) the title opens a menu showing the current page, then the timelines (Following / Followers /
  Longform) and "Browse a relay…" below, so you can jump to a feed from anywhere without going Home first.
- Bumped the bundled helmjs to v0.14.2, adding general primitives now used here: `H-Current-URL` (the
  server can tell which page an action fired from), trigger-relative `H-Retarget` (`closest`/`this`/
  `find`), and `h-dismiss` (opt-in light-dismiss for `<details>` dropdowns, close on outside click or
  Escape). Also picks up a helmjs fix where a declined `h-confirm` fell through to a native form submit.

### Fixed

- The timeline switcher and the account (avatar) dropdowns now close when you click elsewhere on the
  page or press Escape, instead of staying open. Native `<details>` don't light-dismiss on their own;
  the new `h-dismiss` attribute handles it (also applied to the draft-delete confirm).
- Fixed the composer's draft sync getting stuck on "syncing…" forever with nip07 signers. The sync ran
  as an automatic background sign, but browser extensions gate signing on a user gesture (auto-approve
  doesn't bypass that), so the background sign silently stalled and the status never cleared. Now the
  "Save draft" click itself drives the sync: the encrypt/sign/publish chain runs inside that gesture, so
  signing works and can't hang, and the status settles on "Draft saved ✓" (or "Draft saved · not synced"
  if the relay publish failed) with no second button to press. Bunker still syncs automatically and
  silently. Covers note, poll, and article drafts.
- Literal `<br>` tags in article and wiki content now render as line breaks instead of showing as
  escaped text. Authors commonly type `<br />` for spacing; the safe-subset renderer escaped it (correct
  for security) but displayed it verbatim. The bare, attribute-less break (`<br>` / `<br/>` / `<br />`)
  now emits a real line break; any `<br>` carrying attributes stays escaped, so there's no HTML injection.
- Markdown headings written in the underline (Setext) style now render as headings in articles and
  custom-NIP events: a line underlined with `=` becomes an H1 and `-` becomes an H2. Previously only
  `#`-style headings were recognized, so pasted NIP specs and READMEs (which commonly use the underline
  style, e.g. `NIP-54` over `======`) showed the underline as literal text plus a stray horizontal rule.

- Deleting a draft now collapses the row out of the list (a smooth height transition) with the count
  shown in the header ("Drafts · N"), matching the Bookmarks and Muted pages. Deleting the last draft
  shows the empty state in place instead of a blank list (it previously went blank until reload).
  Applies to both signing modes.
- Replaced the draft-delete confirmation: instead of the browser's native "are you sure" dialog, the ✕
  now reveals an inline "Delete" (a two-tap confirm) that matches the app's look, is keyboard-accessible,
  and works with JavaScript off. Clicking ✕ again cancels.
- Unbookmarking an item on the Bookmarks page now collapses it out of the list (a smooth height
  transition) instead of leaving it behind as an un-filled card. Removing the last bookmark shows the
  empty state in place (no reload), and the bookmark count now lives in the header ("Bookmarks · N")
  where it stays live. Works in both signing modes and for both note and article bookmarks.
- The Muted page count moved to the header ("Muted · N") to match Bookmarks, replacing the in-list
  "N muted" row; it stays live as you unmute (the row still collapses as before). Unmuting the last
  person now shows the empty state in place instead of leaving a blank list until reload. Bookmarks and
  mutes now share one removal path (collapse-in-place + live header count).

## [0.4.1] - 2026-07-01

### Fixed

- The composer's "Picture" mode is now reachable from the Article screen. The four compose tabs
  (Note, Picture, Poll, Article) were built in two places, and the Article page's copy had drifted:
  it listed only Note, Poll, and Article, so switching to Article dropped "Picture" from the row and
  you had to back out to Note or Poll to find it again. All four composers now render the tab strip
  from a single shared helper, so the set stays identical everywhere and cannot drift again.

## [0.4.0] - 2026-07-01

### Added

- You can now compose and post picture events (NIP-68, kind 20), not just images inline in a note. A
  new "Picture" mode in the composer (next to Note and Poll) takes a title, a caption, and one or more
  images and publishes a proper kind-20 picture post, with a content-warning toggle for sensitive
  images. Uploaded images now also record their pixel dimensions (a NIP-92 `dim` tag), so pictures and
  other media can render at the right aspect from the start. Works in both signing modes with the same
  undo window as a note. (Composing video is a later phase.)
- Git repositories (NIP-34, kind 30617) now render as a first-class addressable card instead of an
  "unsupported kind" fallback. A repository announcement gets a card in feeds and on profiles (a git
  glyph, the repo name, and description), a detail page (name, description, a Browse action for the
  repo's web page, copyable clone URLs, topics, maintainers, and relays), and a clean preview when referenced
  inline, plus like/zap/bookmark
  and NIP-22 comments keyed by the repo's address. Read-only for now (browse and reference repos);
  issues and patches are a later phase. Repositories default to showing on profiles but not the main
  feed (a per-kind toggle in Settings, like articles and wikis).
- Wiki articles (NIP-54, kind 30818) now render like an article instead of a bare "open in another
  app" link. These are collaborative, topic-slugged articles with an AsciiDoc body: Satori gives
  them the full reader (title, byline, rendered body), a card in feeds and on profiles, and a clean
  preview when one is quoted or referenced inline, plus the usual reply/like/zap/bookmark keyed by
  the article's coordinate. A pragmatic AsciiDoc renderer (headings, lists, links, quotes, code,
  images, inline bold/italic/monospace, and `[[wikilinks]]`) reuses the same escaped, no-innerHTML
  pipeline as the Markdown reader. Wikilinks render as clean links (no raw `[[ ]]` brackets) that
  navigate in-app to the same author's wiki article on that topic, styled with a dotted underline so
  they read distinctly from ordinary (solid-underlined) external links. Wiki articles default to showing on profiles but not the main feed (a per-kind
  toggle in Settings, like articles). This also fixes notes that quote a wiki article: the reference
  now shows a wiki card rather than a generic event link.

### Changed

- A thread or profile URL containing a bare hex id (for example, pasted from a client that does
  not use bech32) now redirects to its canonical `nevent` / `npub` form instead of showing an
  error or serving the raw hex, so the address bar self-heals to the app's bech32 convention.
- The reader-side relay widening (querying your own relays for an event with a stale hint) now
  also covers addressable events - articles, custom NIPs, calendar events, videos - reached
  directly (`/a/`) or as a quoted or embedded reference, not just plain notes and their threads.
- Satori now remembers which relays it has actually seen each author's events on and reuses them
  when fetching that author's notes or articles later. So an event living on a relay the author
  does not advertise in their relay list (and that carries no relay hint in the reference) becomes
  findable once you have encountered that author there, for example by browsing that relay's
  timeline. This is the read side of the outbox model, learned from experience rather than only
  from declared relay lists, and it is remembered across restarts.

### Fixed

- Browsing a single relay now shows its content across every kind you can render (articles, wiki
  articles, and the rest), not just notes and polls. A long-form-only relay - one that serves
  articles and wikis but no plain notes - previously read as an empty timeline; now you see what is
  actually there. As a side benefit this lets Satori learn (see below) which relay an author's
  long-form events live on, just by visiting that relay.
- Notes referenced by an `nevent` that carries no author and a stale relay hint (the hinted
  relay no longer has the event) no longer show "Note not found" when the note is alive on a
  relay you are connected to. Opening a thread, and loading a quoted or replied-to preview,
  now also queries your own read/write relays, not just the shared indexer relays - the
  reader-side of the outbox model. Replies hosted on your relays surface for the same reason.
- Replies and NIP-22 comments whose parent reference is not a resolvable event id (a bech32
  string in the id slot, an address coordinate, a malformed pubkey, or junk) no longer render
  a stray "↗ link" placeholder that points nowhere, and no longer trigger an internal error.
  Satori now cleanly omits the unresolvable "in reply to" context card instead.

- Write-side NIP spec-compliance pass (a multi-NIP audit of the events Satori builds and signs):
  - Replies (NIP-10) now carry the thread **root** marker and the full ancestor participant list, not
    just the immediate parent. A top-level reply is marked `root`; a deeper reply carries both `root`
    and `reply`, so other clients group your replies into the correct thread and every prior
    participant is notified.
  - Reactions (NIP-25) now carry relay + author-pubkey hints on their `e`/`a`/`p` tags and the reacted
    event's real `kind` (previously hardcoded to 1, so a like on a picture, video, or comment was
    mislabeled as a like on a note). Reactions to an addressable event (an article or other
    parameterized-replaceable kind) now also carry the required `e` tag (the specific event id,
    resolved best-effort), not just the `a` coordinate.
  - Zap requests (NIP-57) now include the recommended `lnurl` tag (the recipient's pay endpoint,
    bech32-encoded), so zap receipts can be cross-validated.
  - Synced drafts (NIP-37) now carry a NIP-40 `expiration` (90 days, refreshed on each save) so relays
    can purge stale private drafts. Your local draft is unaffected.
  - Picture posts (NIP-68) always carry a `title` tag now; if you leave the title blank it is derived
    from the caption's first line.

### Security

- The relays Satori learns from experience (see "remembers which relays" above) are screened against
  private / loopback / link-local hosts before being remembered, so a crafted event's relay hint can
  never teach the daemon to keep re-contacting an internal address.
- Private DMs (NIP-17) are now published only to the recipient's own relays, never to public indexer
  relays. Gift-wrapped messages go to the recipient's kind:10050 DM-inbox relays (and your own for your
  kept copy); if a recipient has published no DM-inbox list, delivery falls back to their declared
  NIP-65 read relays rather than broadcasting to indexers, and if they have neither the send fails
  loudly instead of leaking the encrypted wrap (and its recipient metadata) onto shared relays.

## [0.3.1] - 2026-06-30

### Added

- Custom NIPs (kind 30817) now render like an article instead of an "unsupported kind"
  fallback. These are community-authored protocol notes (NUDs): a Markdown body with a
  title and an optional list of the event kinds the NIP defines. Satori gives them the
  full reader (title, byline, rendered Markdown, and chips naming the kinds the NIP
  defines), a card in feeds and on profiles, and a clean preview when one is quoted or
  referenced inline. They get the same affordances an article does - NIP-22 comments,
  like/zap/bookmark, and reply presence - all addressed by the event's `kind:pubkey:d`
  coordinate. Custom NIPs default to showing on profiles but not the main feed (a per-kind
  toggle in Settings, like articles).

### Changed

- Your engagement state (replies, reposts, likes) now reflects correctly on every
  addressable event kind, not just articles - so a calendar event, classified listing, or
  addressable video you have already replied to or liked shows as engaged. Internally, the
  per-kind special-casing was replaced with a single "is this addressable?" check, which is
  what let custom NIPs reuse the article machinery.

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

[0.3.1]: https://github.com/Letdown2491/satori/releases/tag/v0.3.1
[0.3.0]: https://github.com/Letdown2491/satori/releases/tag/v0.3.0
[0.2.1]: https://github.com/Letdown2491/satori/releases/tag/v0.2.1
[0.2.0]: https://github.com/Letdown2491/satori/releases/tag/v0.2.0
[0.1.0]: https://github.com/Letdown2491/satori/releases/tag/v0.1.0
