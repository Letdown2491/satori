// Relay access. Wraps nostr-tools' SimplePool and applies the .onion→Tor-proxy
// rewrite (toPoolUrl) centrally, so no call site has to remember it. This is the
// one place the app talks to relays.

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools';
import { toPoolUrls, fromPoolUrl } from '../nostr/nip65.ts';
import { relaysViaTor } from '../privacy.ts';
import { recordSeen } from './seen-relays.ts';
import { recordLatency } from './relay-latency.ts';
import type { NostrEvent, UnsignedEvent } from '../nostr/types.ts';

/** True if at least one relay accepted a publish (a settled fan-out succeeds on any acceptance). Lives
 * here (the pool, the one place we publish) so publishers can import it without a publish.ts cycle. */
export const anyAccepted = (results: PromiseSettledResult<unknown>[]): boolean => results.some((r) => r.status === 'fulfilled');

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
        this.raw.trackRelays = true; // populate seenOn so we can learn which relays actually carry an author's events

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

    /** Record which relays each event actually arrived on (empirical outbox memory, keyed by author), then
     * DRAIN the consumed seenOn entries - nostr-tools never bounds that map, and we've extracted what we
     * need, so dropping them keeps enabling trackRelays from leaking. Relay urls are mapped back through
     * fromPoolUrl so a Tor-proxied .onion is stored by its real url, not the proxy. */
    private recordSeenOn(events: NostrEvent[]): void {
        if (!events.length) return;
        const seenOn = this.raw.seenOn;
        for (const e of events) {
            const relays = seenOn.get(e.id);
            if (!relays) continue;
            recordSeen(e.pubkey, [...relays].map((r) => fromPoolUrl(r.url)));
            seenOn.delete(e.id);
        }
    }

    // Resolves on all-relay EOSE or maxWait (the safe, complete default). `opts.fast` ALSO resolves once
    // the event stream goes QUIET (no new event for `quiet` ms after data starts) - because all-EOSE rarely
    // fires under wide outbox fan-out (one slow/dead relay never EOSEs), so a complete query rides the full
    // maxWait even when the page's events arrived in the first few hundred ms. `fast` is ONLY safe where the
    // data is redundant across relays (the 2x-routed feed, a profile's notes on the author's relays): a
    // straggler relay adds nothing a fast one didn't. NEVER use it for non-redundant fetches (gift-wrapped
    // DMs/drafts live on one relay set; a read-modify-write of your own lists must see every version) -
    // there an early resolve silently DROPS events. That asymmetry is why complete is the default.
    query(relays: string[], filter: Filter, opts: { fast?: boolean; profile?: boolean } = {}): Promise<NostrEvent[]> {
        const tor = relaysViaTor();
        const maxWait = tor ? TOR_LIST_MAX_WAIT : LIST_MAX_WAIT;
        const quiet = tor ? 1800 : 700;
        this.raw.maxWaitForConnection = tor ? TOR_CONNECT_MAX_WAIT : CONNECT_MAX_WAIT;
        return new Promise<NostrEvent[]>((resolve) => {
            const started = Date.now();
            const events = new Map<string, NostrEvent>();
            let settled = false;
            let lastEventAt = 0;   // when the most recent event arrived (for the latency profile)
            let truncated = false; // did we cut off at the hard cap while the relay was still delivering?
            let quietTimer: ReturnType<typeof setTimeout> | undefined;
            let hardTimer: ReturnType<typeof setTimeout>;
            let sub: { close: (reason?: string) => void } | undefined;
            const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(quietTimer);
                clearTimeout(hardTimer);
                try { sub?.close(); } catch { /* already closed */ }
                const list = [...events.values()];
                this.recordSeenOn(list);
                // Per-relay latency profiling (observation only - see relay-latency.ts). Gated on opts.profile
                // so ONLY the outbox following/followers fan-out feeds it - NOT the "browse a relay" firehose
                // (kinds-only, no author filter), which streams far more events and truncates readily, and would
                // otherwise inflate a browsed relay's outbox budget. Single-relay is a precondition (attribution);
                // measure to the LAST event, not to finish, so the quiet-collapse tail isn't counted as relay time.
                if (opts.profile && relays.length === 1) {
                    const ms = lastEventAt ? lastEventAt - started : Date.now() - started;
                    recordLatency(relays[0]!, ms, truncated, list.length);
                    if (process.env.SATORI_REQ_LOG) console.log(`[relay-latency] ${relays[0]} lastEvent=${ms}ms events=${list.length} truncated=${truncated}`);
                }
                resolve(list);
            };
            hardTimer = setTimeout(() => { truncated = true; finish(); }, maxWait);
            try {
                sub = this.raw.subscribeMany(toPoolUrls(relays), filter as never, {
                    onevent: (e: NostrEvent) => {
                        if (events.has(e.id)) return;
                        events.set(e.id, e);
                        lastEventAt = Date.now();
                        if (opts.fast) { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quiet); }
                    },
                    oneose: () => finish(), // every relay EOSE'd → nothing more is coming
                    maxWait,
                } as never) as { close: (reason?: string) => void };
            } catch { finish(); }
        });
    }

    // `maxWait` (clearnet only) lets a best-effort caller shorten the wait - a decorative quote
    // preview shouldn't hold a relay connection for the full 6s when the event isn't there. Tor keeps
    // its own (longer) cap since circuits are slow and a too-short wait would just always miss.
    get(relays: string[], filter: Filter, maxWait?: number): Promise<NostrEvent | null> {
        const tor = relaysViaTor();
        this.raw.maxWaitForConnection = tor ? TOR_CONNECT_MAX_WAIT : CONNECT_MAX_WAIT;
        return (this.raw.get(toPoolUrls(relays), filter, { maxWait: tor ? TOR_GET_MAX_WAIT : (maxWait ?? GET_MAX_WAIT) }) as Promise<NostrEvent | null>)
            .then((ev) => { if (ev) this.recordSeenOn([ev]); return ev; });
    }

    publish(relays: string[], event: NostrEvent): Promise<PromiseSettledResult<string>[]> {
        return Promise.allSettled(this.raw.publish(toPoolUrls(relays), event as never));
    }

    subscribe(relays: string[], filter: Filter, handlers: SubHandlers) {
        // trackRelays populates seenOn for these events too, but only query()/get() drain it - so a
        // long-lived subscription (e.g. the NIP-46 bunker) would accumulate seenOn entries forever.
        // receivedEvent runs before onevent (relay.js), so seenOn is ready here: record + drain per event.
        const wrapped: SubHandlers = { ...handlers, onevent: (e) => { this.recordSeenOn([e]); handlers.onevent?.(e); } };
        return this.raw.subscribeMany(toPoolUrls(relays), filter as never, wrapped as never);
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
