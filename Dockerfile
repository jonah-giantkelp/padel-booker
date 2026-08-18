# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY server/ server/
COPY web/ web/
RUN npm run build && npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=Europe/London \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Debian's chromium pulls in everything headless Chrome needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# Job queue + Chrome profile + artifacts live in /app/data — attach a Railway
# volume at that mount path so they survive deploys. (No docker VOLUME here;
# Railway rejects the instruction and manages volumes itself.)
CMD ["node", "server/dist/index.js"]
