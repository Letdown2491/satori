#!/bin/sh
# The tor-data volume may carry files owned by a previous image's uid (dperson/torproxy ran
# tor as uid 101; Alpine's tor user differs), and tor refuses a DataDirectory it doesn't
# own. Fix ownership/permissions as root, then exec tor, which drops to `User tor` itself.
set -e
chown -R tor:tor /var/lib/tor
chmod 700 /var/lib/tor
if [ -d /var/lib/tor/hidden_service ]; then chmod 700 /var/lib/tor/hidden_service; fi
exec "$@"
