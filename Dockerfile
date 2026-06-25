# satori-hateoas — a local single-user daemon. No build step: Node runs the
# TypeScript directly via type-stripping (see package.json). Runtime needs only
# nostr-tools; typescript/@types are devDependencies used for `npm run typecheck`.
FROM node:24-alpine

WORKDIR /app

# tzdata so Node/ICU can resolve the local zone. The alpine base ships no
# /usr/share/zoneinfo, so without this Node can't identify a bind-mounted
# /etc/localtime (busybox `date` reads the raw file fine, but Node's ICU needs
# the zone DB to name it and falls back to a wrong guess). With tzdata present,
# mounting the host's /etc/localtime (see docker-compose) makes the daemon track
# the host timezone automatically - no hardcoded TZ. This matters because
# scheduled posts parse + format naive datetime-local values in the local tz.
RUN apk add --no-cache tzdata

# Install runtime deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (overlaid by a bind mount in docker-compose for live-reload dev).
COPY . .

EXPOSE 8787
ENV HOST=0.0.0.0 PORT=8787

# Production default; docker-compose overrides this with `npm run dev` (--watch).
CMD ["node", "--experimental-strip-types", "src/server.ts"]
