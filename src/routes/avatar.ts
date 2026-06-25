// GET /avatar?u=<url> - server-side avatar proxy. Fetches the image once, caches it
// to disk, serves from cache thereafter. Keeps the browser off arbitrary third-party
// hosts (privacy) and smooths slow-host pop-in. On any failure it serves a 1x1
// transparent GIF, so the <img>'s background-color (the colored fallback circle)
// shows through instead of a broken image.

import { getAvatarBytes, putAvatarBytes } from '../data/avatar-cache.ts';
import { torFetch } from '../data/torfetch.ts';
import { isPublicHttpUrl } from '../ssrf.ts';
import type { Ctx } from '../http.ts';

const MAX_BYTES = 8 * 1024 * 1024;  // avatars over this are almost certainly not avatars
const TIMEOUT_MS = 8000;
const LONG_CACHE = 'public, max-age=604800, immutable'; // url-keyed → safe to cache hard
// 1x1 transparent GIF - the graceful fallback (lets the bg-color circle show).
const BLANK = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Same-origin hardening: pin the declared type (nosniff), forbid render-as-document
// (inline), and reject SVG - the one image type that's also a scriptable document and
// never a legitimate avatar.
const SAFE_IMG = { 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' };
const okImage = (ct: string): boolean => ct.startsWith('image/') && !/svg/i.test(ct);

function serveBlank(ctx: Ctx): void {
    ctx.res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=300' });
    ctx.res.end(BLANK);
}

export async function getAvatar(ctx: Ctx): Promise<void> {
    const url = ctx.query.get('u') ?? '';
    if (!url || !isPublicHttpUrl(url)) { serveBlank(ctx); return; }

    const cached = await getAvatarBytes(url);
    if (cached) {
        if (!okImage(cached.ct)) { serveBlank(ctx); return; } // reject SVG even from an older cache
        ctx.res.writeHead(200, { 'Content-Type': cached.ct, 'Cache-Control': LONG_CACHE, ...SAFE_IMG });
        ctx.res.end(cached.bytes);
        return;
    }

    // Miss → fetch (Privacy-Mode-aware via torFetch; redirects re-checked for SSRF),
    // validate it's a reasonable image, serve + cache.
    try {
        const r = await torFetch(url, TIMEOUT_MS, MAX_BYTES);
        const ct = String(r.headers['content-type'] ?? '');
        if (r.status !== 200 || !okImage(ct)) { serveBlank(ctx); return; }
        ctx.res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': LONG_CACHE, ...SAFE_IMG });
        ctx.res.end(r.body);
        void putAvatarBytes(url, r.body, ct); // cache after serving (don't slow the first hit)
    } catch { serveBlank(ctx); } // strict Privacy Mode with Tor blocked → blank
}
