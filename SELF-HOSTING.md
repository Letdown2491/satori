# Self-hosting Satori

Satori is a single-user daemon: you run your own, and it's yours. This covers running it for
real (production), exposing it as a Tor `.onion` so you can reach it from anywhere, and locking
sign-in to you.

There are two ways to reach your daemon:

- **Locally** at `http://127.0.0.1:8787` (the bootstrap/admin door).
- **From anywhere over Tor**, via a `.onion` address (below). `8787` is never published to the
  internet; Tor is the only way in.

## 1. Run it (production)

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

This builds the image and runs the real server (no dev bind-mounts, no file watcher). Data
(sessions, your owner claim, caches, drafts, scheduled posts) lives in the `satori-data` volume.

## 2. Lock sign-in to you (access control)

The daemon decides **who may sign in**. Default: the **first sign-in claims the instance** as
owner; everyone else is rejected. If you sign in locally before exposing the `.onion`, that's you.

For an exposed instance, prefer setting the owner **explicitly** (race-free) in
`docker-compose.prod.yml`:

```yaml
    environment:
      - SATORI_OWNER=npub1yourownnpub          # just you
    # or a trusted group:
      - SATORI_ALLOWED_PUBKEYS=npub1a,npub1b
    # or a public instance (see "Public instances" below):
      - SATORI_OPEN=1
```

The boot log prints the effective policy: `[access] restricted to 1 pubkey`, `[access] open (...)`,
or `[access] restricted, UNCLAIMED (...)`.

## 3. Get your `.onion`

Once the `tor` container has bootstrapped (about a minute on first run):

```sh
docker compose -f docker-compose.prod.yml exec tor cat /var/lib/tor/hidden_service/hostname
```

That prints your address, e.g. `qcxyrf7oebw23cni4kt5jnkjvtw5grvoxhztxl5lpsskvilmhddbx2ad.onion`.
Open it in **Tor Browser**. The owner lock from step 2 means only you can actually sign in.

## 4. Client authorization (recommended)

The owner lock stops anyone from *signing in*, but the `.onion` is still *reachable* by anyone who
learns the address. Tor v3 **client authorization** makes it unreachable - invisible - to anyone
without your key. Strongly recommended for a truly private door.

Generate a keypair:

```sh
sh tor/gen-client-auth.sh
```

It prints two halves:

- **SERVER** - `descriptor:x25519:<PUBLIC>`. Put it on the tor container:

  ```sh
  docker compose -f docker-compose.prod.yml exec tor sh -c \
    'echo "descriptor:x25519:<PUBLIC>" > /var/lib/tor/hidden_service/authorized_clients/me.auth'
  docker compose -f docker-compose.prod.yml restart tor
  ```

  Any file ending in `.auth` in `authorized_clients/` is read; add one per device/person.

- **CLIENT** - your private key. In **Tor Browser**, the first time you open the `.onion` it will
  prompt for the key; paste the private string. (Or place
  `<onion-without-.onion>:descriptor:x25519:<PRIVATE>` in your `ClientOnionAuthDir`.)

After this, the `.onion` simply won't resolve for anyone who hasn't installed the private key.

## Public instances

Setting `SATORI_OPEN=1` lets **anyone** sign in (their own Nostr identity, their own isolated
session) - the hosted-client model. Before running a real public instance, be aware this is a
different threat model (you become an operator who can see users' transient content), and the
daemon still needs hardening that isn't done yet: per-user persistence (the shared JSON stores
block the event loop under concurrency), rate limiting, and SSRF-guarding every user-supplied URL.
Self-hosting for yourself or a trusted group needs none of that.

## Notes

- **Bootstrap before exposing.** If you rely on first-sign-in ownership rather than `SATORI_OWNER`,
  sign in once at `127.0.0.1:8787` before anyone can reach the `.onion`, so *you* claim it.
- **You can drop the local port.** Once you've claimed ownership and only want `.onion` access,
  remove the `127.0.0.1:8787:8787` line and rely on Tor entirely.
- **Tor version.** The `dperson/torproxy` image works but is dated; for a long-lived deployment
  consider a maintained Tor image with a hand-written `torrc` (same `HiddenServiceDir` +
  `HiddenServicePort 80 satori-hateoas:8787`).
- **HTTPS / clearnet.** If you expose over clearnet (a domain) instead of `.onion`, put it behind a
  TLS-terminating reverse proxy; cookies upgrade to `Secure` when it sees `X-Forwarded-Proto: https`.
