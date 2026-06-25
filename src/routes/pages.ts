// Settings (appearance) + placeholders for the nav destinations not yet built.
// Each placeholder renders in the correct chrome so navigation never 404s and the
// look is complete; the real features arrive in later phases.

import { html } from '../html.ts';
import { profileCacheStats } from '../data/profile-cache.ts';
import { avatarCacheStats } from '../data/avatar-cache.ts';
import { engagementStats } from '../data/engagement-cache.ts';
import { requireLogin, chromeFor } from './common.ts';
import { readAppearance, writeAppearance, parseZapPresets, THEMES, type Theme } from '../theme.ts';
import { prefToggle, PREF_FIELDS } from '../render/settings.ts';
import { readForm, redirect, sendPage, sendFragment, type Ctx } from '../http.ts';

// --- Settings (appearance) -------------------------------------------------
// The settings PAGE + relay editor live in routes/settings.ts; this is just the
// appearance-cookie write that the theme/text forms post to.

export async function postAppearance(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const form = await readForm(ctx.req);
    // Merge ONLY the fields this form actually sent, so a single-field post (e.g. a
    // number field) doesn't clobber theme, and vice versa.
    const next = { ...readAppearance(ctx) };
    if (form.has('theme')) { const t = form.get('theme'); if (t && THEMES.includes(t as Theme)) next.theme = t as Theme; }
    if (form.has('newNotesThreshold')) next.newNotesThreshold = Math.max(1, Math.min(50, Math.floor(Number(form.get('newNotesThreshold')) || 5)));
    // Boolean toggles, handled generically so a new PREF_FIELD never gets silently dropped here.
    for (const f of PREF_FIELDS) if (form.has(f)) next[f] = form.get(f) === '1';
    if (form.has('undoSeconds')) next.undoSeconds = Math.max(1, Math.min(30, Math.floor(Number(form.get('undoSeconds')) || 5)));
    writeAppearance(ctx, next);
    // A reload is needed when the change affects the page BEYOND its own widget and a local
    // swap can't reach it: theme (lives on <html>), and trustScores (gates the relay/search
    // chips via a class on the settings-page ROOT, which only a full render updates). Other
    // prefs (threshold, media toggle, undo) are self-contained, so a no-reload field gets 204.
    const needsReload = form.has('theme') || form.has('trustScores');
    if (ctx.isPartial) {
        if (needsReload) { ctx.res.writeHead(200, { 'H-Refresh': 'true' }); ctx.res.end(); return; }
        // A pref toggle re-renders itself with the flipped state (its form swaps outer).
        for (const f of PREF_FIELDS) {
            if (form.has(f)) { sendFragment(ctx, prefToggle(f, next[f])); return; }
        }
        ctx.res.writeHead(204); ctx.res.end(); // number/upload-server fields: native value already shows
    } else redirect(ctx, '/settings');
}

// --- Wallet ----------------------------------------------------------------
// No spending credential is ever stored server-side (by design). So this page
// isn't Satori's NWC balance/send/receive - it's the parts that need no secret:
// WebLN one-tap status (revealed by CSS via the lib's `data-webln` flag), your
// own lightning address (to receive), and the zap-preset preferences the zap
// dialog reads. Balance/send/receive would require holding a spending key, which
// we deliberately don't (the user's explicit constraint).

/** GET /metrics - JSON perf counters. Login-gated, and engagement is scoped to the
 * caller (no cross-user aggregation), so it stays sound if ever run multi-tenant. */
export function getMetrics(ctx: Ctx): void {
    const s = requireLogin(ctx);
    if (!s) return;
    ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    ctx.res.end(JSON.stringify({ profileCache: profileCacheStats(), avatarCache: avatarCacheStats(), engagement: engagementStats(s.me) }, null, 2));
}

export function getWallet(ctx: Ctx): void {
    const s = requireLogin(ctx);
    if (!s) return;
    const a = readAppearance(ctx);
    const lud16 = s.profiles.get(s.me)?.lud16;
    const content = html`
      <div class="wallet view-pad">
        <div class="wallet-status">
          <span class="wallet-chip on webln-on">⚡ One-tap zaps · WebLN connected</span>
          <span class="wallet-chip off webln-off">No WebLN · zaps open an invoice in any wallet</span>
        </div>
        <p class="wallet-hint webln-off">Add a WebLN extension like <a href="https://getalby.com" target="_blank" rel="noopener">Alby</a> for one-tap zaps.</p>
        <section class="wallet-card">
          <h3>Receive zaps</h3>
          ${lud16
            ? html`<div class="wallet-addr-hero"><span class="bolt">⚡</span><span class="addr">${lud16}</span></div><p class="wallet-hint">Others can zap you at this lightning address.</p>`
            : html`<p class="wallet-hint">No lightning address set. Add a <code>lud16</code> to your <a href="/profile/edit" h-scroll="top instant">profile</a> to receive zaps.</p>`}
        </section>
        <section class="wallet-card">
          <h3>Zap amounts</h3>
          <form class="wallet-presets" action="/wallet" method="post" h-post>
            <input class="wallet-input" type="text" name="presets" value="${a.zapPresets.join(', ')}" placeholder="21, 100, 500, 1000, 5000" autocomplete="off" spellcheck="false">
            <button type="submit">Save</button>
          </form>
          <p class="wallet-hint">The amounts offered in the zap dialog.</p>
        </section>
        <section class="wallet-card">
          <h3>Your keys, your wallet</h3>
          <p class="faint">Satori never stores a spending key. There’s no balance or send/receive here by design, so your wallet stays yours. Zaps are paid one-tap through your WebLN extension, or by opening the invoice in any external wallet.</p>
        </section>
      </div>`;
    sendPage(ctx, content, chromeFor(ctx, s, { active: 'wallet', title: 'Wallet' }));
}

export async function postWallet(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const form = await readForm(ctx.req);
    writeAppearance(ctx, { ...readAppearance(ctx), zapPresets: parseZapPresets(form.get('presets') ?? '') });
    redirect(ctx, '/wallet'); // boosted fetch follows the 303 → re-render; zero-JS reloads
}
