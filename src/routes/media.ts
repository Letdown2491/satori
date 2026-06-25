// GET /media?u=<url> - proxy a note's inline IMAGE through the daemon, so the browser
// never connects to the third-party host (no IP/cookies/referrer leak), and the
// daemon's own fetch honors Privacy Mode via torFetch (direct off / Tor on). Disk-
// cached (the shared image byte cache) + SSRF-guarded (the url is from arbitrary note
// content). Mirrors /avatar; video is NOT proxied yet (needs Range/streaming) so it
// stays direct. On any failure: a 1x1 transparent GIF (so the <img> just shows blank).

import { isPublicHttpUrl } from '../ssrf.ts';
import { torFetch } from '../data/torfetch.ts';
import { getAvatarBytes, putAvatarBytes } from '../data/avatar-cache.ts';
import { sendFragment, type Ctx } from '../http.ts';
import { videoEmbed } from '../render/content.ts';

const MAX_BYTES = 25 * 1024 * 1024;  // generous for images, but bounded
const TIMEOUT_MS = 12000;            // images over a cold Tor circuit can be slow
const LONG_CACHE = 'public, max-age=604800, immutable'; // url-keyed → safe to cache hard
const BLANK = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function serveBlank(ctx: Ctx): void {
    ctx.res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=300' });
    ctx.res.end(BLANK);
}

export async function getMedia(ctx: Ctx): Promise<void> {
    const url = ctx.query.get('u') ?? '';
    if (!url || !isPublicHttpUrl(url)) { serveBlank(ctx); return; } // SSRF guard (url is from a note)

    const cached = await getAvatarBytes(url);
    if (cached) {
        ctx.res.writeHead(200, { 'Content-Type': cached.ct, 'Cache-Control': LONG_CACHE });
        ctx.res.end(cached.bytes);
        return;
    }

    // Miss → fetch (Privacy-Mode-aware), validate it's a reasonable image, serve + cache.
    try {
        const r = await torFetch(url, TIMEOUT_MS, MAX_BYTES);
        const ct = String(r.headers['content-type'] ?? '');
        if (r.status !== 200 || !ct.startsWith('image/')) { serveBlank(ctx); return; }
        ctx.res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': LONG_CACHE });
        ctx.res.end(r.body);
        void putAvatarBytes(url, r.body, ct); // cache after serving (don't slow the first hit)
    } catch { serveBlank(ctx); } // strict Privacy Mode with Tor blocked → fail closed (blank)
}

/** GET /video?u=<url>&dim=<dim> - the autoplaying <video> for a poster-less video facade,
 * swapped in (helmjs) when the user clicks the play placeholder. Render-only (the <video src>
 * still streams direct, like all video); the facade's <a href> is the no-JS fallback. */
export function getVideoEmbed(ctx: Ctx): void {
    sendFragment(ctx, videoEmbed(ctx.query.get('u') ?? '', ctx.query.get('dim') ?? undefined));
}
