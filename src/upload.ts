// Server-side media upload (Blossom only - NIP-96 is effectively dead; Blossom is
// the de-facto standard and supports multiple servers). The Blossom auth (kind:24242,
// BUD-02) is built as a template, signed either by the bunker (server) or the
// extension (nip07 sign-and-resubmit), then THIS server PUTs the blob to every server
// in your kind:10063 list (first success wins). Counts / notifying others are out of
// scope, matching Satori.

import type { Pool } from './data/pool.ts';
import type { Signer } from './data/signer.ts';
import type { RelayList, NostrEvent, UnsignedEvent } from './nostr/types.ts';
import { INDEXER_RELAYS } from './nostr/nip65.ts';
import { torRequest } from './data/torfetch.ts';
import { isPublicHttpUrl } from './ssrf.ts';

const KIND_BLOSSOM_LIST = 10063;
// Fallback when you haven't set a kind:10063 media-server list, so uploads work
// out-of-box. Override by adding your own in Settings → Media servers.
export const DEFAULT_BLOSSOM_SERVER = 'https://blossom.primal.net';
const now = () => Math.floor(Date.now() / 1000);
const trim = (u: string) => u.replace(/\/+$/, '');
const serverWriteTargets = (r: RelayList | null): string[] => (r && r.write.length ? r.write : INDEXER_RELAYS);

export interface Upload { url: string; imeta: string[] } // a single NIP-92 imeta tag

/** Your Blossom server list (kind:10063 `server` tags), newest wins. */
export async function fetchBlossomServers(pool: Pool, me: string, myRelays: RelayList | null): Promise<string[]> {
    const relays = [...new Set([...(myRelays?.read ?? []), ...(myRelays?.write ?? []), ...INDEXER_RELAYS])];
    const events = await pool.query(relays, { kinds: [KIND_BLOSSOM_LIST], authors: [me] }).catch(() => []);
    const ev = events.sort((a, b) => b.created_at - a.created_at)[0];
    return ev ? ev.tags.filter((t) => t[0] === 'server' && t[1]).map((t) => trim(t[1]!)) : [];
}

/** Build the unsigned kind:10063 Blossom server list (no signing/publishing). */
export function serverListTemplate(me: string, servers: string[]): UnsignedEvent {
    return { kind: KIND_BLOSSOM_LIST, created_at: now(), pubkey: me, content: '', tags: servers.map((s) => ['server', trim(s)]) };
}

/** Publish a signed kind:10063 to your write relays (nip07: extension signed). */
export async function publishServerListSigned(pool: Pool, signed: NostrEvent, myRelays: RelayList | null): Promise<void> {
    const results = await pool.publish(serverWriteTargets(myRelays), signed);
    if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no relay accepted the media server list');
}

/** Sign (bunker) + publish a kind:10063 server list. */
export async function publishServerList(pool: Pool, signer: Signer, me: string, myRelays: RelayList | null, servers: string[]): Promise<void> {
    const signed = await signer.signEvent(serverListTemplate(me, servers)) as NostrEvent;
    await publishServerListSigned(pool, signed, myRelays);
}

export async function sha256Hex(bytes: Buffer): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Unsigned Blossom auth (BUD-02): kind:24242, not URL-bound, so one signature
 * is reusable across every server in your list. */
export function blossomAuthTemplate(me: string, hash: string): UnsignedEvent {
    return {
        kind: 24242, created_at: now(), pubkey: me, content: 'Upload blob',
        tags: [['t', 'upload'], ['x', hash], ['expiration', String(now() + 3600)]],
    };
}

const authHeader = (signed: NostrEvent): string => `Nostr ${btoa(JSON.stringify(signed))}`;

/** Upload one blob to a single Blossom server (PUT /upload) with a signed auth. */
async function blossomPut(server: string, bytes: Buffer, contentType: string, signed: NostrEvent): Promise<{ url: string; sha256: string; type?: string }> {
    // torRequest, not raw fetch: an upload is outbound traffic and must honor Privacy Mode
    // (Strict fails closed via Tor, never leaking the clearnet IP to the Blossom server).
    const res = await torRequest(`${trim(server)}/upload`, {
        method: 'PUT',
        headers: {
            Authorization: authHeader(signed),
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': String(bytes.length),
        },
        body: bytes,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`blossom upload failed (${res.status})`);
    let j: { url?: string; sha256?: string; type?: string } | null = null;
    try { j = JSON.parse(res.body.toString('utf8')); } catch { j = null; }
    if (!j?.url) throw new Error('blossom returned no url');
    return { url: j.url, sha256: j.sha256 ?? '', type: j.type };
}

/** Upload to all Blossom servers (first success wins, like Satori). */
export async function blossomUploadAll(servers: string[], bytes: Buffer, contentType: string, hash: string, signed: NostrEvent): Promise<Upload> {
    // SSRF symmetry with torFetch: the upload PUT is outbound traffic to a user-listed host,
    // so drop any server that resolves to a private/loopback target before we connect.
    const safe = servers.filter((s) => isPublicHttpUrl(`${trim(s)}/upload`));
    const results = await Promise.allSettled(safe.map((s) => blossomPut(s, bytes, contentType, signed)));
    const ok = results.find((r) => r.status === 'fulfilled');
    if (!ok || ok.status !== 'fulfilled') throw new Error('no Blossom server accepted the upload');
    const blob = ok.value;
    const imeta = ['imeta', `url ${blob.url}`, ...(blob.type || contentType ? [`m ${blob.type || contentType}`] : []), `x ${blob.sha256 || hash}`];
    return { url: blob.url, imeta };
}
