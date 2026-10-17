# The server for the NAS. It needs nothing from npm at run time: Node 24 runs
# the TypeScript directly and has SQLite built in.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    TZ=Australia/Sydney \
    PLEX_TRACKER_HOST=0.0.0.0 \
    PLEX_TRACKER_PORT=7000 \
    PLEX_TRACKER_DATA_DIR=/data \
    PLEX_TRACKER_AUTH=plex

# tzdata so TZ works on Alpine; the app's own dates use Sydney time regardless.
RUN apk add --no-cache tzdata

VOLUME /data
EXPOSE 7000

HEALTHCHECK --interval=1m --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:7000/api/health > /dev/null || exit 1

CMD ["node", "src/server.ts"]
