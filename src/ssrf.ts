// SSRF guard for server-side fetches of USER-CONTROLLED urls (avatar proxy, lnurl /
// zap endpoints, nip05, …). A malicious profile - an avatar URL, a lightning address,
// a nip05 domain - must not be able to make this daemon fetch internal services. We
// block non-http(s) schemes and private / loopback / link-local hosts. DNS rebinding
// is NOT covered (acceptable for a local single-user daemon); callers that follow
// redirects should re-check the final url with this too.

import net from 'node:net';

export function isPublicHttpUrl(raw: string): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Node returns IPv6 hostnames wrapped in brackets ("[::1]"); strip them before any
    // check, or every IPv6 literal silently bypasses the guard.
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (net.isIPv4(host)) return isPublicIPv4(host);
    if (net.isIPv6(host)) return isPublicIPv6(host);
    // A hostname (not an IP literal) - allow. DNS rebinding is out of the threat model.
    return true;
}

/** True iff the dotted-quad IPv4 is not loopback / private / link-local / unspecified. */
function isPublicIPv4(ip: string): boolean {
    return !/^(127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

/** True iff the IPv6 literal is not loopback / ULA / link-local / unspecified, and -
 * for IPv4-mapped/compatible forms (dotted or hex) - the embedded IPv4 is public. */
function isPublicIPv6(ip: string): boolean {
    const h = ip.toLowerCase();
    if (h === '::1' || h === '::') return false; // loopback / unspecified
    // IPv4-mapped/compatible, dotted form: ::ffff:127.0.0.1 or ::127.0.0.1
    const dotted = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted && (h.startsWith('::ffff:') || h.startsWith('::'))) return isPublicIPv4(dotted[1]!);
    // IPv4-mapped, hex form (Node normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1)
    const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
        const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
        return isPublicIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    if (/^f[cd]/.test(h)) return false;   // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return false; // fe80::/10 link-local
    return true;
}
