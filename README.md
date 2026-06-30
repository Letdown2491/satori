# Satori

Satori is a nostr client that runs on the server instead of in your browser. No SPA, no
framework, no application JavaScript: the server sends HTML, the browser renders it, and
you move around with links and forms. The only client code is two small libraries
(helm.js and hext.js), and nothing else of mine ships to the browser.

It still behaves like a modern client. Likes register the moment you tap them, the feed
scrolls without paging, images open full-screen, the composer completes `@`-mentions and
`:`emoji as you type. That is plain HTML and CSS with those two libraries doing the work.
With JavaScript off you can still read, post, zap, and message.

## Why it's built this way

A nostr key is your whole identity, so I didn't want Satori anywhere near mine. It never
sees your key: you sign with a NIP-46 bunker or a NIP-07 extension, and the server only
ever handles the signed result. No nsec login, no stored secrets, no Lightning spending
key. Keeping the browser thin is part of the same idea, less code running there is less
that can leak or be turned against you, and a strict CSP stops the page from loading
anything off-origin or running inline script.

It also doesn't fish for your attention. There are no like or repost counts, reactions
are off by default, and the home feed ends: when you're caught up it says so instead of
refilling forever. The look is sumi-e, ink on paper, and the build follows the Taoist
uncarved block, leave out whatever doesn't need to be there.

And it's yours to run. Satori is a single-user daemon that lives on your own machine, and
you can reach it from anywhere over Tor as a hidden service only your key can open.

## How it works

The browser loads two scripts. I wrote both for Satori, but neither depends on it:

- [helm.js](https://github.com/Letdown2491/helmjs) is a small htmx-style hypermedia
  engine: swap a fragment, poll, toggle a class. It works on any server-rendered site.
- [hext.js](https://github.com/Letdown2491/hextjs) wires your signer and wallet into the
  page without giving them up: the server sends an unsigned event, your bunker or
  extension signs it, and the signed copy comes back to be verified and published. Any
  HATEOAS nostr app can use it for NIP-07 signing and WebLN payment.

The rest is ordinary hypermedia. An action returns new HTML and helm.js swaps it into
place. An optimistic state is just a CSS class flipped on click and corrected when the
server replies. Infinite scroll is an "older" link that fires when it scrolls into view;
the lightbox is pure CSS. Because none of it is custom client code, it degrades to plain
links and forms, and it is all reusable.

## What's in it

Close to a full client: feeds, threads, profiles, long-form articles, polls, private DMs,
search, zaps, notifications, drafts, bookmarks, follows, and mutes. Pictures, video,
calendar events, classifieds, podcasts, highlights, and custom NIPs render as proper cards instead of
sending you off to another app. Media goes through the daemon so your browser never
connects to a stranger's host (and a dead image can be refetched by its hash), anything
the server fetches can be routed over Tor, and a short undo window holds a post before it
is actually sent.

## Run it

No build step. Node runs the TypeScript directly.

```bash
npm install
npm start          # http://127.0.0.1:8787
```

Requires Node 22.6 or newer. Sign in with a `bunker://` string or a NIP-07 extension
(Alby, nos2x, and friends).

Prefer Docker? This also brings up a Tor sidecar for `.onion` relays:

```bash
docker compose up -d --build     # http://127.0.0.1:8787
docker compose logs -f satori
```

`npm run dev` restarts on change; `npm run typecheck` is the gate.

## Self-hosting

Run the production stack and it is yours:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Lock sign-in to yourself with `SATORI_OWNER=npub1you` (or let the first sign-in claim
it). To reach it from anywhere, the stack publishes a Tor `.onion`, and port 8787 never
touches the internet. Add Tor client authorization (`sh tor/gen-client-auth.sh`) and the
address becomes invisible to anyone without your key. Everything except the login page
requires a session, so a stranger who finds the address meets a wall, not your data.

## License

[MIT](LICENSE) © 2026 Letdown2491 · changes are tracked in [CHANGELOG.md](CHANGELOG.md).
