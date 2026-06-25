// Relay access. Wraps nostr-tools' SimplePool and applies the .onion→Tor-proxy
// rewrite (toPoolUrl) centrally, so no call site has to remember it. This is the
// one place the app talks to relays.

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools';
import { toPoolUrls, fromPoolUrl } from '../nostr/nip65.ts';
import { relaysViaTor } from '../privacy.ts';
import type { NostrEvent, UnsignedEvent } from '../nostr/types.ts';

export interface SubHandlers {
    onevent?: (e: NostrEvent) => void;
    oneose?: () => void;
}

const normUrl = (u: string) => u.replace(/\/+$/, '').toLowerCase();

// Reliability caps so one slow/dead relay can't stall a render: a query returns
// whatever arrived by the deadline instead of waiting for EVERY relay to EOSE.
// Healthy relays answer well under these, so a complete result is the norm - the
// cap only bites when a relay is actually sick (exactly when you want to cut it).
const LIST_MAX_WAIT = 4000;     // multi-event queries (feed/thread/profile/lists)
const GET_MAX_WAIT = 6000;      // single-event get: null = a broken page, so more rope (resolves instantly when found)
const CONNECT_MAX_WAIT = 4000;  // don't chase an unreachable relay's socket longer than this
// Privacy Mode (Tor): building a Tor circuit cold takes seconds, well past the direct
// caps - so a COLD query (e.g. right after toggling on / recycling) would time out and
// return empty (a blank feed) before the relays even connect. Give Tor queries much
// more rope; once circuits are warm, relays still answer fast (the cap rarely bites).
const TOR_LIST_MAX_WAIT = 12000;
const TOR_GET_MAX_WAIT = 12000;
const TOR_CONNECT_MAX_WAIT = 11000;

export class Pool {
    readonly raw = new SimplePool();
    // NIP-42 AUTH: sign the kind:22242 challenge - but only for relays in your own
    // list (authing to strangers' relays would broadcast your identity everywhere).
    private authSign: ((tmpl: UnsignedEvent) => Promise<NostrEvent>) | null = null;
    private authRelays = new Set<string>();
    // Warm-up tracking for the Privacy Mode indicator: which relays are dialing and
    // which have settled (connected OR failed), so the widget shows real progress.
    private warming: { urls: Set<string>; settled: Set<string> } | null = null;

    constructor() {
        this.raw.maxWaitForConnection = CONNECT_MAX_WAIT;
        (this.raw as { automaticallyAuth?: unknown }).automaticallyAuth = (url: string) => {
            if (!this.authSign || !this.authRelays.has(normUrl(url))) return undefined;
            const sign = this.authSign;
            return (tmpl: UnsignedEvent) => sign(tmpl);
        };
    }

    /** Provide the auth signer + the relays we're willing to authenticate to. */
    setAuth(sign: (tmpl: UnsignedEvent) => Promise<NostrEvent>, relays: string[]): void {
        this.authSign = sign;
        this.setAuthRelays(relays);
    }
    setAuthRelays(relays: string[]): void {
        this.authRelays = new Set(toPoolUrls(relays).map(normUrl));
    }

    query(relays: string[], filter: Filter): Promise<NostrEvent[]> {
        const tor = relaysViaTor();
        this.raw.maxWaitForConnection = tor ? TOR_CONNECT_MAX_WAIT : CONNECT_MAX_WAIT;
        return this.raw.querySync(toPoolUrls(relays), filter, { maxWait: tor ? TOR_LIST_MAX_WAIT : LIST_MAX_WAIT }) as Promise<NostrEvent[]>;
    }

    get(relays: string[], filter: Filter): Promise<NostrEvent | null> {
        const tor = relaysViaTor();
        this.raw.maxWaitForConnection = tor ? TOR_CONNECT_MAX_WAIT : CONNECT_MAX_WAIT;
        return this.raw.get(toPoolUrls(relays), filter, { maxWait: tor ? TOR_GET_MAX_WAIT : GET_MAX_WAIT }) as Promise<NostrEvent | null>;
    }

    publish(relays: string[], event: NostrEvent): Promise<PromiseSettledResult<string>[]> {
        return Promise.allSettled(this.raw.publish(toPoolUrls(relays), event as never));
    }

    subscribe(relays: string[], filter: Filter, handlers: SubHandlers) {
        return this.raw.subscribeMany(toPoolUrls(relays), filter as never, handlers as never);
    }

    /** Live status of content relays - every open relay minus the given transport
     * relays - with .onion relays shown by their real URL (not the proxy URL). */
    contentRelays(transport: string[]): { url: string; connected: boolean }[] {
        const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
        const t = new Set(transport.map(norm));
        const out: { url: string; connected: boolean }[] = [];
        for (const [url, connected] of this.raw.listConnectionStatus()) {
            if (t.has(norm(url))) continue;
            out.push({ url: fromPoolUrl(url), connected });
        }
        return out.sort((a, b) => a.url.localeCompare(b.url));
    }

    /** Force-drop relay connections (closing their subscriptions and deleting the
     * relay so the next use builds a fresh socket) - clears the zombie sockets a
     * resume from sleep leaves behind. Pass specific URLs to recycle just those
     * (e.g. the bunker transport); omit to recycle every open relay. Callers must
     * re-establish any long-lived subscriptions afterwards; one-shot queries
     * reconnect on their own. */
    recycle(urls?: string[]): void {
        this.warming = null; // a recycle invalidates any in-flight warm progress
        const targets = urls?.length ? toPoolUrls(urls) : [...this.raw.listConnectionStatus().keys()];
        if (targets.length) this.raw.close(targets);
    }

    /** Pre-open connections to the given relays in the background (best-effort) and
     * track progress, so a warming indicator can show real connected/total and know
     * when every attempt has settled (healthy connected, the rest failed). Idempotent:
     * a no-op while a cycle is still in flight; starts a fresh cycle once it settles.
     * Dials with the Tor connection timeout when Privacy Mode is on (cold circuits). */
    warm(relays: string[]): void {
        if (this.warming) {
            if (this.warming.settled.size < this.warming.urls.size) return; // cycle in flight
            // Completed cycle: don't restart (which would reset progress and re-loop the
            // indicator forever) while every warmed relay is still connected.
            let up = 0;
            for (const [url, isUp] of this.raw.listConnectionStatus()) if (isUp && this.warming.urls.has(normUrl(url))) up++;
            if (up >= this.warming.urls.size) return;
        }
        const poolUrls = toPoolUrls(relays);
        if (!poolUrls.length) { this.warming = null; return; }
        const timeout = relaysViaTor() ? TOR_CONNECT_MAX_WAIT : CONNECT_MAX_WAIT;
        this.raw.maxWaitForConnection = timeout;
        const state = { urls: new Set(poolUrls.map(normUrl)), settled: new Set<string>() };
        this.warming = state;
        for (const url of poolUrls) {
            const n = normUrl(url);
            try { void this.raw.ensureRelay(url, { connectionTimeout: timeout }).then(() => state.settled.add(n), () => state.settled.add(n)); }
            catch { state.settled.add(n); }
        }
    }

    /** Warm-up progress for the current cycle: relays connected vs total, and whether
     * every attempt has settled (= done; healthy ones connected, the rest failed). */
    warmProgress(): { connected: number; total: number; ready: boolean } | null {
        const w = this.warming;
        if (!w || w.urls.size === 0) return null;
        let connected = 0;
        for (const [url, up] of this.raw.listConnectionStatus()) if (up && w.urls.has(normUrl(url))) connected++;
        return { connected, total: w.urls.size, ready: w.settled.size >= w.urls.size };
    }

    closeAll(): void {
        try { this.raw.destroy(); } catch { /* ignore */ }
    }
}
