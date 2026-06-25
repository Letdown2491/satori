# Satori — hypermedia edition

A full-featured [nostr](https://github.com/nostr-protocol/nostr) client built as a
**server-rendered hypermedia (HATEOAS) application** instead of a client-side SPA —
a faithful re-imagining of the SPA client [Satori](../nostr-client), with the same
look, feel, and design philosophy, rebuilt on a fundamentally different machine.

It is, deliberately, a **showcase**: proof that hypermedia — server-rendered HTML,
links and forms, progressively enhanced — can deliver a *modern* web-app experience
(optimistic UI, in-place updates, infinite scroll, live regions, a full-screen
media lightbox) without shipping a single line of application-specific JavaScript.
HATEOAS isn't the norm anymore; this is an argument that it doesn't have to be a
downgrade — and a pile of reusable patterns for doing the same.

The browser runs exactly **two** scripts, both general-purpose libraries, neither
app-specific:

- **[helmjs](../helmjs)** (`public/helm.js`) — an htmx-style hypermedia engine.
- **[hateoas-extensions](../hateoas-extensions)** (`public/hx-ext.js`) — bridges
  browser *credentials/capabilities* into the hypermedia flow: NIP-07 signing and
  WebLN payment, via a sign/pay-and-resubmit primitive.

Everything else is server-rendered HTML + CSS.

## Philosophy

Three invariants drive every decision:

1. **Satori's look & feel** — the Sumi-e visual language (ink on washi), the calm
   uncluttered UX, the ensō, the copy. The CSS is a verbatim port.
2. **Satori's values** — minimalism, *no vanity metrics* (no like/repost counts),
   the full NIP-65 outbox model, privacy-first (**the signing key never touches
   this server**; no spending key is ever stored), progressive disclosure.
3. **The HATEOAS layer** (additive) — a zero-JS baseline that *degrades
   gracefully*, with helmjs as the engine (not a fallback) and the server as the
   single source of truth for application state.

Internal code does **not** mirror Satori's SPA structure — it can't, and shouldn't.
Where hypermedia expresses something more cleanly than a literal translation of
client-side JavaScript, that's the design.

## Features

Login (bunker or extension) · four feeds (Following · Followers · Beyond · Longform,
all outbox-routed with infinite scroll + a live "new notes" pill) · profiles (with
pinned + articles strips, and a kind:0 editor) · threads · the NIP-23 article reader
& composer · rich compose (notes, replies, quotes, content warnings, polls, media
upload, @-mention & :emoji autocomplete) · likes · zaps (NIP-57 invoices + WebLN
one-tap) · a no-custody wallet · notifications (with an unread bell) · NIP-22 article
comments · drafts · bookmarks · follows · mutes (with feed/thread/notif filtering) ·
media galleries + a full-screen lightbox · NIP-36 content-warning blur · long-note
clamping · `.onion` relays over Tor · an undo window before publishing.

**Optimistic UI:** like / bookmark / pin / follow / mute / poll-vote all flip
**instantly** on click, then reconcile against the server's authoritative response
(and roll back on failure) — see below.

## Reusable hypermedia patterns

The point of the project. Each "modern" interaction is expressed declaratively in
server HTML + helmjs attributes — no bespoke client code — so they're liftable.

| Interaction | How it's done (zero app JS) |
|---|---|
| **In-place updates** | a `<form>`/`<a>` returns the new fragment; `h-target`/`h-swap` place it. Underneath: real form POST + 303 redirect. |
| **Optimistic actions** | `h-optimistic="class:active"` flips the control's state class the instant you click; the response-swap reconciles, an `h:error` reverts. The on-state look is CSS-driven so the flip is real. |
| **Sign-and-resubmit** | the server returns an *unsigned* event + a continuation URL (`H-Nostr-Sign`); hateoas-extensions has the extension sign it and POSTs it back to verify + publish. The key never leaves the browser. |
| **Pending vs. success** | for extension (NIP-07) signing the optimistic flip reads as *pending* during the prompt; it reconciles on approve, reverts on reject/timeout — honest, not fake. |
| **WebLN one-tap zap** | the invoice response carries `H-Webln-Pay` + a continuation; hateoas-extensions pays via `window.webln` and resubmits the preimage. The secret stays in the extension. |
| **Infinite scroll** | a real `older →` link, upgraded to `h-trigger="intersect once"` — fetches the next page + a fresh sentinel. |
| **Lazy hydration** | embed cards, the poll box, profile strips and relay trust-scores load via `h-trigger="intersect"/"load"`, replacing a zero-JS fallback in place. |
| **Live regions** | the "new notes" pill and unread bell poll with `h-trigger="every Ns"`. |
| **Full-screen lightbox** | pure CSS `:target` + `:has()` — a tile is an `#id` link; the overlay shows while its slide is targeted; ‹ › are neighbour links. No JS. |
| **CW blur / Show-more** | a hidden checkbox whose label is the overlay; CSS reveals on `:checked`. Persistent, independent, zero-JS. |
| **Undo window** | the server *holds* the signed event; a countdown toast polls `/note/tick`, which publishes at the deadline or is cancelled by `/note/undo`. Closing the tab = cancel (matches Satori). |
| **Caret editing** | `@`/`:` autocomplete uses helmjs `h-selection` (sends the caret) + `h-insert` (splices at the caret) + `h-combobox` (arrow/enter nav). |
| **Theme without flash** | appearance lives in a server cookie (SSR), so there's no FOUC; a theme change returns `H-Refresh`. |

## Signing — the key never touches the server

Two modes, both keeping the key off this process:

- **NIP-46 bunker** (`bunker://…`) — the server is the NIP-46 *client*; the bunker
  signs. Works with **JavaScript disabled**. The server also does NIP-42 relay AUTH
  for bunker sessions.
- **NIP-07 extension** (Alby, nos2x, …) — the extension signs in the browser via
  hateoas-extensions; the server only builds the unsigned template, verifies the
  signed result, and publishes (outbox routing stays server-side). A JS-only
  enhancement (an extension can't sign without JS).

> **Server obligation — escaping.** Unsigned-event bodies are serialized with `&`,
> `<`, `>` escaped (`signRequestBody`, `src/http.ts`): helmjs runs a boosted form's
> response through `DOMParser` before the sign hook, which would otherwise corrupt
> the JSON the extension signs. `JSON.parse` decodes the escapes transparently.

## Run

No build step — Node runs the TypeScript directly via type-stripping.

```bash
npm install
npm start            # → http://127.0.0.1:8787
npm run dev          # same, with --watch
npm run typecheck    # tsc --noEmit (strict)
```

**Requirements:** Node ≥ 22.6 (global `WebSocket`, native TS type-stripping).
Runtime deps: `nostr-tools`, plus `ws` + `socks-proxy-agent` (for Tor `.onion`
relays). Sign in with a `bunker://` string **or** a NIP-07 extension.

### Docker (+ Tor)

```bash
docker compose up -d --build            # build + start (http://127.0.0.1:8787)
docker compose logs -f satori-hateoas   # follow logs
docker compose down                     # stop
```

`src/` and `public/` are bind-mounted under `node --watch`, so edits auto-restart
the daemon (rebuild only on dependency changes). The compose stack includes a **Tor
SOCKS5 sidecar**; `.onion` relays added in Settings are routed through it
(`TOR_SOCKS=socks5h://tor:9050`). Clearnet relays connect directly. Remove
`TOR_SOCKS` to disable Tor (onion relays then simply fail).

It's a **local single-user daemon**: the browser hits localhost, the bunker
connection lives in an in-memory session keyed by an httpOnly `sid` cookie, and the
port is published only on `127.0.0.1`.

## Architecture

```
src/
  server.ts     owned Node http server: route table, static assets, sessions
  http.ts       request context, cookies, form/multipart parsing, response + sign helpers
  html.ts       owned templating: html`` tagged template, escapes by construction
  session.ts    in-memory single-user session store (bunker link, per-request caches)
  theme.ts      appearance prefs in a cookie (SSR, no flash)
  undo.ts       server-held events for the undo window
  nip07.ts      NIP-07 challenge + signed-event verification
  nostr/        pure protocol core, vendored from Satori (NIP-10/19/22/23/65/88,
                content tokenizer, markdown) — kept verbatim for upstream syncability
  data/         data services (pool, signer, feeds, relays, profiles, publish,
                reactions, zap, trust, profile-extras, ws-tor) — ours to shape
  render/       server-side renderers (string-emitting): content, note, layout,
                actions, compose, settings, poll, zap, comments, …
  routes/       login, feed, read, note, poll, like, actions, zap, comment, article,
                profile, settings, notifications, suggest, upload, pages
public/         helm.js + hx-ext.js (the only client scripts), styles.css (verbatim
                Sumi-e port, both themes)
```

**`html`` vs `h()`:** Satori's `h()` returns DOM nodes (safe by construction); here
`html\`\`` returns escaped HTML strings (safe by construction). The content
tokenizer and markdown parser are shared verbatim; the renderers emit strings over
them, so `@mentions → <a href="/u/npub1…">`, quotes → `/t/…`, articles → `/a/…`,
with strict escaping throughout.

### Security posture

- **Escape-by-default templating.** The only un-escaped paths are `raw()` and nested
  `html\`\`` templates; all user/relay content flows through escaping. URLs are
  scheme-checked (`safeUrl`) so `javascript:`/`data:` can't execute.
- **CSP** `script-src 'self'` (no inline scripts), httpOnly `SameSite=Lax` session
  cookie, `no-referrer`.
- **No secrets on the server:** no signing key (bunker/extension hold it), no
  Lightning spending key (WebLN keeps it in the extension).

---

Sibling projects (reference): [Satori](../nostr-client) (the SPA this ports),
[helmjs](../helmjs), [hateoas-extensions](../hateoas-extensions).
