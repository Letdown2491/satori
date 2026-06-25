// The timelines. Four tabs share one machinery:
//   following - your follows' notes, outbox-routed (their NIP-65 write relays).
//   followers - people who follow you, same outbox routing.
//   beyond    - an algorithmic relay's trending notes (a curated single page).
//   longform  - your follows' NIP-23 long-form (kind:30023).
// Following/Followers/Longform paginate (?until cursor + infinite scroll) and
// carry a "new notes" poller; Beyond is a single curated page.

import { buildFollowsRoute, buildFollowersRoute, fetchRoutedPage, fetchTrendingPage } from '../data/feeds.ts';
import { html, type SafeHtml } from '../html.ts';
import { noteList, naddrFor, pagerSentinel } from '../render/note.ts';
import { emptyItem } from '../render/svg.ts';
import { quote } from '../render/quotes.ts';
import { page, notesHome } from '../render/layout.ts';
import { readAppearance } from '../theme.ts';
import { readReadState, advanceReadState } from '../read-state.ts';
import { requireLogin, ensureProfiles, notePubkeys, chromeFor } from './common.ts';
import { ensureLists, mutedPubkeys, PRIVATE_KINDS, actionKind } from '../actions.ts';
import { getFilters, compileFilters } from '../data/filters.ts';
import { cachedFeed, putCachedFeed } from '../data/feed-cache.ts';
import { ensureLikes } from '../likes.ts';
import { ensureEngaged, engageTarget } from '../engaged.ts';
import { ensureZaps } from '../zaps.ts';
import { ensureReplies, ensureArticleReplies, replierPubkeys } from '../replies.ts';
import { sendPage, sendFragment, sendSignRequest, notFound, redirect, type Ctx } from '../http.ts';
import { readSignResult } from '../nip07.ts';
import type { Session } from '../session.ts';
import { signsOnClient } from '../session.ts';
import { FEED_KINDS } from '../manifest/feed-config.ts';
import type { FeedTab } from '../render/layout.ts';
import type { NostrEvent } from '../nostr/types.ts';

const PAGE = 30;
const LONGFORM_PAGE = 20;
// The new-notes indicators (both the off-feed dot and the on-feed mark) stay quiet
// until the user's newNotesThreshold (readAppearance) new notes have gathered - a
// calm nudge, not a live counter.
// Feed fetch-kinds now live in the local manifest's IA config (manifest/feed-config.ts).

const TABS: FeedTab[] = ['following', 'followers', 'commons', 'longform'];

/** The private (NIP-44) list kinds still awaiting a nip07 decrypt this session.
 * Until decrypted they can't filter the feed (mutes) OR fill the bookmark glyph
 * (bookmarks) - the same cold-start gap for EVERY private list, not just mutes.
 * (Bunker decrypts server-side in ensureLists, so it's never pending.) */
export function pendingPrivateKinds(s: Session & { me: string }): number[] {
    if (!signsOnClient(s)) return []; // bunker decrypts server-side in ensureLists - never pending
    return [...PRIVATE_KINDS].filter((k) => !!s.lists.get(k)?.content && !s.privateTags.has(k));
}

/** A one-shot, invisible primer that decrypts the pending private lists (nip07) on a
 * cold load, so mute/bookmark state is correct. Chains one decrypt per pending list,
 * then EITHER re-renders #feed (`tab`, the feed's in-place path) OR soft-reloads the
 * current page (`ret`, via H-Location - used on the profile/thread, which have no #feed
 * to swap). Reject a prompt and the page stays as-is (it already rendered; nothing strands). */
export function listPrimer(q: { tab?: FeedTab; ret?: string }): SafeHtml {
    const qs = q.ret ? `ret=${encodeURIComponent(q.ret)}` : `tab=${q.tab ?? 'following'}`;
    return html`<span id="list-primer" h-get="/notes/list-prime?${qs}" h-trigger="load" h-target="#list-primer" h-swap="none" h-push-url="false" aria-hidden="true"></span>`;
}

/** The ?ret= soft-reload target - a LOCAL path only (no open redirect), else ''. */
function retParam(ctx: Ctx): string {
    const r = ctx.query.get('ret') ?? '';
    return /^\/[^/]/.test(r) ? r : '';
}

/** Resolve the ?tab= query to a known feed tab (defaults to following). */
function tabParam(ctx: Ctx): FeedTab {
    const t = ctx.query.get('tab');
    return t && (TABS as string[]).includes(t) ? (t as FeedTab) : 'following';
}

/** A valid private-list kind from ?kind=, else null. */
function privKindParam(ctx: Ctx): number | null {
    const n = Number(ctx.query.get('kind'));
    return PRIVATE_KINDS.has(n) ? n : null;
}

const PATHS: Record<FeedTab, string> = { following: '/', followers: '/followers', commons: '/commons', longform: '/longform' };
const paginates = (tab: FeedTab) => tab !== 'commons';
const pageSize = (tab: FeedTab) => (tab === 'longform' ? LONGFORM_PAGE : PAGE);
const kindsFor = (tab: FeedTab) => (tab === 'longform' ? FEED_KINDS.longform : FEED_KINDS.note);

/** The outbox route for a tab (cached on the session). Beyond has no route. */
async function routeFor(s: Session & { me: string }, tab: FeedTab): Promise<Map<string, Set<string>>> {
    if (tab === 'commons') return new Map();
    if (tab === 'followers') {
        if (!s.followersRoute) s.followersRoute = await buildFollowersRoute(s.pool, s.me, s.myRelays!).catch(() => ({ authors: [], route: new Map() }));
        return s.followersRoute.route;
    }
    // following + longform share the follows route (same authors, different kinds)
    if (!s.followsRoute) s.followsRoute = await buildFollowsRoute(s.pool, s.me, s.myRelays!).catch(() => ({ authors: [], route: new Map() }));
    return s.followsRoute.route;
}

async function fetchPage(s: Session & { me: string }, tab: FeedTab, until?: number, limit?: number): Promise<NostrEvent[]> {
    if (tab === 'commons') return fetchTrendingPage(s.pool).catch(() => [] as NostrEvent[]);
    const route = await routeFor(s, tab);
    return fetchRoutedPage(s.pool, route, limit ?? pageSize(tab), until, kindsFor(tab)).catch(() => [] as NostrEvent[]);
}

/** Infinite-scroll sentinel for a tab (delegates to the shared pager sentinel). */
function sentinel(tab: FeedTab, until: number): SafeHtml {
    const sep = PATHS[tab].includes('?') ? '&' : '?';
    return pagerSentinel(`${PATHS[tab]}${sep}until=${until}`);
}

/** Build a feed page's content + the newest-note timestamp (for the bar's notes
 * poller). `newestTs` is undefined for Beyond (no poller - curated single page). */
const MAX_FILL = 4;   // cap loop-fill fetches so an aggressive filter can't fan out unbounded
const OVERFETCH = 3;  // when filtering, the first window pulls this many × target raw, so the
                      // common case fills the page in ONE round-trip instead of several sequential

/** Fetch until ~pageSize VISIBLE notes accumulate (muted authors + content filters can thin a
 * raw window well below target). When filtering, the first window over-fetches (OVERFETCH×) so
 * one round-trip usually suffices; MAX_FILL bounds the fallback loop. No extra cost when nothing
 * is filtered. We consume events one-by-one and stop at `target`, advancing the cursor to the
 * LAST CONSUMED event - so over-fetching never renders too many notes nor opens a pagination gap
 * (the un-consumed tail is simply re-read by the next window). Returns the visible notes, the raw
 * events consumed (for the list-primer's private-list check), a `more` sentinel, and the newest
 * raw timestamp (the notes-dot high-water). */
async function fillPage(s: Session & { me: string }, tab: FeedTab, until?: number): Promise<{ visible: NostrEvent[]; allRaw: NostrEvent[]; more: SafeHtml | null; newestRaw: number }> {
    // Load the lists CONCURRENTLY with the first page fetch, not serially before it: mute is only
    // needed once the page returns (filtering), bookmark/pin only at render. Awaited inside the loop
    // after the fetch (so it overlaps it) - saves ~1 round-trip on a cold paint (a full ~12s on Tor).
    const listsReady = ensureLists(s, ['mute', 'bookmark', 'pin']);
    const filt = compileFilters(getFilters(s.me), 'feed');
    let muted = new Set<string>(); // filled once listsReady resolves (first iteration), before any keep()
    const keep = (e: NostrEvent): boolean => !muted.has(e.pubkey) && !filt.hide(e);
    const target = pageSize(tab);
    const anchorable = paginates(tab);
    const overfetch = filt.active && anchorable; // Beyond is a single curated page → never over-fetch
    const visible: NostrEvent[] = [];
    const allRaw: NostrEvent[] = [];
    let cursor = until;
    let newestRaw = 0, exhausted = false;
    for (let i = 0; i < MAX_FILL && visible.length < target; i++) {
        const lim = i === 0 && overfetch ? target * OVERFETCH : target;
        // Landing window (until=undefined): serve the brief cache to skip the relay query on a
        // re-visit; cache only on a miss (so the TTL stays bounded, not refreshed on every visit).
        let page: NostrEvent[];
        if (i === 0 && until === undefined) {
            const cached = cachedFeed(s.me, tab);
            if (cached) page = cached;
            // Cache only a NON-EMPTY result: a transient empty (e.g. Beyond's external relay returning
            // nothing on a cold pooled connection) must not get cached, or it'd blank the tab for the
            // whole TTL. An empty page just falls through to a fresh fetch on the next visit.
            else { page = await fetchPage(s, tab, cursor, lim); if (page.length) putCachedFeed(s.me, tab, page); }
        } else {
            page = await fetchPage(s, tab, cursor, lim);
        }
        if (i === 0) { await listsReady; muted = mutedPubkeys(s); } // lists overlapped the fetch above; ready before any keep()
        if (!page.length) { exhausted = true; break; }
        if (!newestRaw) newestRaw = page[0]!.created_at; // newest raw of the first window
        for (const e of page) {
            allRaw.push(e);
            cursor = e.created_at - 1; // advance per-event so a mid-window stop leaves no gap
            if (keep(e)) { visible.push(e); if (visible.length >= target) break; }
        }
        if (page.length < lim) { exhausted = true; break; } // short window → end of the feed
    }
    // Enrich only what we render (not the filtered-out raw). `replyKeys` = note ids (or article
    // naddrs on longform) for reply-presence; after it resolves, hydrate the replier avatars.
    const replyKeys = tab === 'longform' ? visible.map(naddrFor) : visible.filter((e) => e.kind === 1).map((e) => e.id);
    // The Commons is always uncached + relay-slow, so wait fully for its reply-faces (full=true) -
    // else they reliably miss the bounded window on first load; the hot feeds stay snappy (bounded).
    await Promise.all([ensureProfiles(s, [s.me, ...notePubkeys(visible)]), ensureLikes(s, visible.map((e) => e.id)), ensureEngaged(s, visible.map(engageTarget)), ensureZaps(s), tab === 'longform' ? ensureArticleReplies(s, replyKeys) : ensureReplies(s, replyKeys, tab === 'commons')]);
    await ensureProfiles(s, replierPubkeys(replyKeys)); // real avatars for the reply faces (only un-cached repliers hit a relay)
    const more = anchorable && !exhausted ? sentinel(tab, cursor!) : null;
    return { visible, allRaw, more, newestRaw };
}

async function buildFeed(s: Session & { me: string }, tab: FeedTab, until?: number): Promise<{ content: SafeHtml; newestTs: number | undefined; events: NostrEvent[] }> {
    const { visible, allRaw, more, newestRaw } = await fillPage(s, tab, until);
    const anchorable = paginates(tab);
    // nip07: kick off the private-list decrypt as the feed lands, then it re-renders.
    const primer = pendingPrivateKinds(s).length ? listPrimer({ tab }) : null;
    const body = visible.length === 0 && allRaw.length === 0
        ? emptyItem(quote(tab === 'commons' ? 'commons' : 'empty'))
        : html`${noteList(visible, s.profiles, s, { mute: tab === 'commons' })}${more}`;
    return {
        content: html`<ul class="feed" id="feed">${body}</ul>${primer}`,
        newestTs: anchorable ? (newestRaw || Math.floor(Date.now() / 1000)) : undefined,
        events: allRaw, // raw (pre-filter) so the list-primer can detect private-muted authors to hide
    };
}

/** Does the decrypted private mute/bookmark state actually change how THIS page of notes
 * renders? True iff a now-muted author or a now-bookmarked note id is on the page. Lets the
 * list-primer skip its #feed re-swap (the post-login "glitch") when nothing visible changes. */
function privateAffectsPage(s: Session, events: NostrEvent[]): boolean {
    const privMuted = new Set((s.privateTags.get(actionKind('mute')) ?? []).filter((t) => t[0] === 'p').map((t) => t[1]));
    const privMarked = new Set((s.privateTags.get(actionKind('bookmark')) ?? []).filter((t) => t[0] === 'e').map((t) => t[1]));
    return events.some((e) => privMuted.has(e.pubkey) || privMarked.has(e.id));
}

/** Shared handler for all four tabs (and their infinite-scroll partials). */
async function serveFeed(ctx: Ctx, tab: FeedTab): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    const untilParam = ctx.query.get('until');
    const until = untilParam && /^\d+$/.test(untilParam) ? Number(untilParam) : undefined;

    // Infinite-scroll partial: just the next notes + a fresh sentinel. Loop-fill keeps each
    // scroll increment ~pageSize even when filters/mutes thin the raw windows.
    if (ctx.isPartial && ctx.hTarget === '#more') {
        const { visible, more } = await fillPage(s, tab, until);
        sendFragment(ctx, html`${noteList(visible, s.profiles, s, { mute: tab === 'commons' })}${more}`);
        return;
    }

    const { content, newestTs } = await buildFeed(s, tab, until);
    if (until === undefined && newestTs) markFeedSeen(ctx, s, tab, newestTs); // viewing the feed = seen
    sendPage(ctx, content, chromeFor(ctx, s, { active: 'feed', feedTab: tab, notesSince: newestTs }));
}

/** The new-notes dot tracks the FOLLOWING timeline (your "home"); viewing/loading it
 * advances the high-water in the client cookie (read-state.ts; monotonic) so a reload/
 * restart doesn't relight the dot. */
function markFeedSeen(ctx: Ctx, s: Session & { me: string }, tab: FeedTab, ts: number): void {
    if (tab !== 'following' || ts <= 0) return;
    advanceReadState(ctx, s.me, { feed: ts });
}

/** GET /notes/dot - the ambient new-notes poller (off the feed): light the dot when
 * the Following timeline has notes newer than your seen high-water. */
export async function getNotesDot(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    if (!ctx.isPartial) { redirect(ctx, '/'); return; }
    const seen = readReadState(ctx, s.me).feed;
    const threshold = readAppearance(ctx).newNotesThreshold;
    const muted = mutedPubkeys(s);
    const filt = compileFilters(getFilters(s.me), 'feed');
    // Respect the same calm-nudge threshold as the on-feed mark: the ambient dot lights only
    // once enough new notes have gathered. Query TIGHTLY - only events newer than `seen`, capped
    // near the threshold (+slack for muted) - instead of pulling a full timeline page every 60s.
    // Content-filtered notes don't count toward the dot (they won't show in the feed anyway).
    const route = await routeFor(s, 'following');
    const events = await fetchRoutedPage(s.pool, route, threshold + 5, undefined, kindsFor('following'), seen).catch(() => [] as NostrEvent[]);
    const count = events.filter((e) => e.created_at > seen && !muted.has(e.pubkey) && !filt.hide(e)).length;
    sendFragment(ctx, notesHome(count >= threshold));
}

export const getFeed = (ctx: Ctx) => serveFeed(ctx, 'following');
export const getFollowers = (ctx: Ctx) => serveFeed(ctx, 'followers');
export const getCommons = (ctx: Ctx) => serveFeed(ctx, 'commons');
export const getLongform = (ctx: Ctx) => serveFeed(ctx, 'longform');

/** The full Following-feed document - used by sign-in / post-note continuations.
 * `extra` (e.g. the undo toast) is placed inside the body so a body-swap keeps it. */
export async function feedDocument(ctx: Ctx, s: Session & { me: string }, extra?: SafeHtml): Promise<SafeHtml> {
    const { content, newestTs } = await buildFeed(s, 'following');
    return page(html`${content}${extra ?? html``}`, chromeFor(ctx, s, { active: 'feed', feedTab: 'following', notesSince: newestTs }));
}

/** GET /notes/list-prime - kick off the private-list decrypt chain (nip07). Returns
 * a nip44_decrypt request for the first pending list; 204 if nothing's pending. */
export async function getListPrime(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    if (!ctx.isPartial) { redirect(ctx, '/'); return; }
    await ensureLists(s, ['mute', 'bookmark']);
    const [kind] = pendingPrivateKinds(s);
    const content = kind != null ? s.lists.get(kind)?.content : undefined;
    if (kind == null || !content) { ctx.res.writeHead(204); ctx.res.end(); return; }
    const carry = retParam(ctx) ? `ret=${encodeURIComponent(retParam(ctx))}` : `tab=${tabParam(ctx)}`;
    sendSignRequest(ctx, { pubkey: s.me, ciphertext: content }, `/notes/list-primed?${carry}&kind=${kind}`, 'nip44_decrypt');
}

/** POST /notes/list-primed - cache one decrypted list, then either chain to the next
 * pending list or, when none remain, re-render #feed (now filtered + glyphs correct).
 * A failed/rejected decrypt caches null so the chain won't retry that list. */
export async function postListPrimed(ctx: Ctx): Promise<void> {
    const s = requireLogin(ctx);
    if (!s) return;
    await ensureLists(s, ['mute', 'bookmark']);
    const kind = privKindParam(ctx);
    if (kind != null) {
        let priv: string[][] | null = null;
        try { const j = JSON.parse(String(await readSignResult(ctx.req))); if (Array.isArray(j)) priv = j as string[][]; } catch { /* unreadable */ }
        s.privateTags.set(kind, priv);
    }
    const tab = tabParam(ctx);
    const ret = retParam(ctx);
    const carry = ret ? `ret=${encodeURIComponent(ret)}` : `tab=${tab}`;
    const [next] = pendingPrivateKinds(s);
    const nextContent = next != null ? s.lists.get(next)?.content : undefined;
    if (next != null && nextContent) {
        sendSignRequest(ctx, { pubkey: s.me, ciphertext: nextContent }, `/notes/list-primed?${carry}&kind=${next}`, 'nip44_decrypt');
        return;
    }
    // Done. Profile/thread: soft-reload the current page (H-Location) so its mute/
    // bookmark state re-renders correctly. Feed: swap #feed in place.
    if (ret) { ctx.res.writeHead(200, { 'H-Location': ret }); ctx.res.end(); return; }
    const { content, events } = await buildFeed(s, tab);
    // Only re-swap the feed when the freshly-decrypted lists actually change a visible note
    // (a now-muted author drops out, or a bookmark glyph flips). Otherwise skip the swap so
    // the feed you're already reading doesn't flash/jump for nothing.
    if (!privateAffectsPage(s, events)) { ctx.res.writeHead(204); ctx.res.end(); return; }
    sendFragment(ctx, content, { 'H-Reswap': 'outer', 'H-Retarget': '#feed' });
}
