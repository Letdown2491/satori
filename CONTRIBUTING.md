# Contributing

Thanks for your interest. A few things about this codebase that are worth knowing up front.

## Setup

```bash
npm install
npm run dev        # http://127.0.0.1:8787, restarts on change
npm run typecheck  # tsc --noEmit (strict) - the quality gate
```

**No build step.** Node runs the TypeScript directly via type-stripping, so there is no
compile/bundle. Requires **Node >= 22.6** (global `WebSocket` + native TS stripping).
Because `tsc` passing does not guarantee the runtime *loads* every module, the project
also boots the server in CI as a smoke test; `npm start` locally does the same check.

## How it's built

- **Zero-JS baseline.** Every feature must work, or degrade gracefully, with JavaScript
  off. The browser runs only two general-purpose libraries (`public/helm.js`,
  `public/hext.js`); there is no application-specific client JavaScript, and PRs should
  not add any (no inline `<script>`, no `on*=` handlers).
- **helm.js / hext.js are vendored, not edited here.** They are separate libraries
  shipped as static assets. New generic hypermedia capability belongs in them, not in a
  one-off here; app behavior belongs server-side.
- **Escape by construction.** All output goes through the `html\`\`` tagged template,
  which escapes every interpolation. The only un-escaped sinks are `raw()` (for
  already-trusted markup) and nested `html\`\`` templates, never for user or relay
  content. URLs go through `safeUrl`.
- **Server is the source of truth.** Optimism is a presentation concern; the server's
  response reconciles it.

## Conventions

- Match the surrounding code's style, comment density, and naming.
- Reuse the shared helpers rather than re-rolling them (URL/tag/nip19/render/cache
  utilities already exist); do not over-abstract bespoke logic.
- Keep parity across equivalent surfaces (notes and articles, bunker and NIP-07) and
  across signing modes.

## Before opening a PR

- `npm run typecheck` is clean.
- The server boots (`npm start`) and the change works with JS both on and off.
- No secrets, and nothing under `.data/` (runtime state, gitignored) is committed.
