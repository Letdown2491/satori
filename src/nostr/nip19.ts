// NIP-19 / NIP-21: decode a bare bech32 entity (the part after `nostr:`) into a
// shape the content renderer can use. Thin wrapper over nostr-tools' decode.

import { decode } from 'nostr-tools/nip19';

export interface AddrPointer { kind: number; pubkey: string; identifier: string; relays: string[] }

export type DecodedEntity =
    | { kind: 'mention'; pubkey: string; bech: string }
    | { kind: 'quote'; id: string; relays: string[]; bech: string }
    | { kind: 'address'; addr: AddrPointer; bech: string }
    | { kind: 'other'; type: string; bech: string };

export function decodeEntity(bech: string): DecodedEntity | null {
    let decoded;
    try { decoded = decode(bech); } catch { return null; }
    const { type, data } = decoded;
    if (type === 'npub') return { kind: 'mention', pubkey: data as string, bech };
    if (type === 'nprofile') return { kind: 'mention', pubkey: (data as { pubkey: string }).pubkey, bech };
    if (type === 'note') return { kind: 'quote', id: data as string, relays: [], bech };
    if (type === 'nevent') {
        const d = data as { id: string; relays?: string[] };
        return { kind: 'quote', id: d.id, relays: d.relays ?? [], bech };
    }
    if (type === 'naddr') {
        const d = data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
        return { kind: 'address', addr: { kind: d.kind, pubkey: d.pubkey, identifier: d.identifier, relays: d.relays ?? [] }, bech };
    }
    return { kind: 'other', type, bech };
}
