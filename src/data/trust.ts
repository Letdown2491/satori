// Relay trust scores from trustedrelays.xyz (the source Satori uses). The fetch runs
// server-side here (the daemon, not the browser). Disk-backed + stale-while-revalidate
// (mirrors profile-cache): scores survive a restart - instant on the next view - and
// only refresh every few hours (they change rarely). An explicit "no score" (null) is
// cached; network/parse failures are NOT (retryable, but a prior value is kept served).
// PER-INSTANCE (single-user daemon, own .data/) - not shared across users.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { torFetch } from './torfetch.ts';

const API = 'https://trustedrelays.xyz/api/score';
const FILE = process.env.SATORI_TRUST_CACHE || join(process.cwd(), '.data', 'trust.json');
const STALE_MS = 12 * 60 * 60 * 1000; // 12h → serve cached, refresh in the background
const CAP = 5000;

interface Entry { score: number | null; at: number }
const norm = (url: string) => url.replace(/\/+$/, ''); // the API expects no trailing slash

const cache = new Map<string, Entry>();
(function load(): void {
    try {
        const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Entry>;
        for (const [url, e] of Object.entries(raw)) if (e && typeof e.at === 'number') cache.set(url, e);
    } catch { /* no cache yet */ }
})();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFlush(): void {
    if (flushTimer) return; // at most one write per window; the Map is current at flush time
    flushTimer = setTimeout(() => {
        flushTimer = null;
        try {
            if (cache.size > CAP) { // keep the most-recently-refreshed
                const keep = [...cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, CAP);
                cache.clear();
                for (const [k, v] of keep) cache.set(k, v);
            }
            mkdirSync(dirname(FILE), { recursive: true });
            writeFileSync(FILE, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
        } catch (e) { console.warn('[trust] flush failed:', (e as Error)?.message ?? e); }
    }, 8000);
}

/** Fetch + cache a fresh score; on failure keep (and return) any prior value. */
async function refresh(key: string): Promise<number | null> {
    try {
        const res = await torFetch(`${API}?url=${encodeURIComponent(key)}`, 10_000, 256 * 1024); // Privacy-Mode-aware
        if (res.status !== 200) return cache.get(key)?.score ?? null; // failure not cached
        const json = JSON.parse(res.body.toString('utf8')) as { data?: { score?: number } };
        const score = typeof json.data?.score === 'number' ? json.data.score : null;
        cache.set(key, { score, at: Date.now() });
        scheduleFlush();
        return score;
    } catch {
        return cache.get(key)?.score ?? null; // network/timeout - serve prior if any
    }
}

/** Trust score (0-100), or null for no score. Instant from the disk-backed cache when
 * present; refreshes in the background once an entry is older than STALE_MS. */
export async function fetchTrustScore(url: string): Promise<number | null> {
    const key = norm(url);
    const hit = cache.get(key);
    if (hit) {
        if (Date.now() - hit.at > STALE_MS) void refresh(key); // stale-while-revalidate
        return hit.score;
    }
    return refresh(key);
}
