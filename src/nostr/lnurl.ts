// LUD-06: decode a bech32 `lnurl…` string to its https URL. Owned (bech32 is
// small + stable) so nostr-tools stays our only runtime dependency.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Decode an LNURL (bech32, no length cap) to its URL, or null if malformed.
 * The checksum isn't verified - a bad decode yields a bad URL that simply fails
 * to fetch, which the zap flow already handles gracefully. */
export function decodeLnurl(lnurl: string): string | null {
    const s = lnurl.trim().toLowerCase();
    const sep = s.lastIndexOf('1');
    if (sep < 1 || s.slice(0, sep) !== 'lnurl') return null;
    const words: number[] = [];
    for (const ch of s.slice(sep + 1)) {
        const v = CHARSET.indexOf(ch);
        if (v === -1) return null;
        words.push(v);
    }
    if (words.length < 6) return null;
    // 5-bit words → 8-bit bytes (dropping the 6-word checksum at the end).
    let acc = 0, bits = 0;
    const bytes: number[] = [];
    for (const w of words.slice(0, -6)) {
        acc = (acc << 5) | w;
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
    }
    try { return new TextDecoder().decode(Uint8Array.from(bytes)) || null; }
    catch { return null; }
}
