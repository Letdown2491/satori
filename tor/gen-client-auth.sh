#!/bin/sh
# Generate a Tor v3 onion CLIENT-AUTHORIZATION keypair, so only devices holding the private key can
# even reach your .onion (it's invisible to everyone else). Needs openssl (1.1+) and base32.
# See the Self-hosting section of README.md for where each half goes (server half:
# /var/lib/tor/hidden_service/authorized_clients/<anyname>.auth on the tor container).
set -e
KEY=$(openssl genpkey -algorithm x25519 2>/dev/null)
PRV=$(printf '%s' "$KEY" | openssl pkey -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')
PUB=$(printf '%s' "$KEY" | openssl pkey -pubout -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')
echo
echo "SERVER  -> add this line to  authorized_clients/<anyname>.auth  on the tor container:"
echo "    descriptor:x25519:$PUB"
echo
echo "CLIENT  -> your Tor Browser onion-auth PRIVATE key (keep it secret):"
echo "    $PRV"
echo
