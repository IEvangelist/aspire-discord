# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /src

COPY package.json package-lock.json ./
COPY AspireDiscordBot.AppHost/package.json AspireDiscordBot.AppHost/package.json
COPY AspireDiscordBot.Bot/package.json AspireDiscordBot.Bot/package.json
RUN npm ci

COPY AspireDiscordBot.Bot AspireDiscordBot.Bot
RUN npm run build --workspace @aspire-discord/bot \
    && npm prune --omit=dev --workspaces

FROM node:24-bookworm-slim AS final
ENV NODE_ENV=production
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=build /src/node_modules ./node_modules
COPY --chown=node:node --from=build /src/package.json ./package.json
COPY --chown=node:node --from=build /src/AspireDiscordBot.Bot/package.json ./AspireDiscordBot.Bot/package.json
COPY --chown=node:node --from=build /src/AspireDiscordBot.Bot/dist ./AspireDiscordBot.Bot/dist

USER node
WORKDIR /app/AspireDiscordBot.Bot

EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/src/index.js"]
