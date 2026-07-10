# Owned Tor sidecar (SOCKS proxy + optional v3 hidden service).
#
# This replaced the off-the-shelf dperson/torproxy image, which had not been rebuilt since
# 2020: a Tor that old no longer recognizes enough of the network's directory authorities
# to validate a consensus, so it hung at "Bootstrapped 30% (loading_status)" forever,
# logging "Consensus not signed by sufficient number of requested authorities". Alpine's
# tor package tracks current stable; rebuild with
#   docker compose build --no-cache tor
# whenever you want to pick up a newer Tor - on your schedule, not a stranger's.
FROM alpine:latest
RUN apk add --no-cache tor
COPY torrc /etc/tor/torrc
COPY torrc-hidden-service /etc/tor/torrc-hidden-service
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
# Default: SOCKS only (the dev compose). Prod overrides `command` with the hidden-service torrc.
CMD ["tor", "-f", "/etc/tor/torrc"]
