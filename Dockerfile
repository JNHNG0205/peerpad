# syntax=docker/dockerfile:1
# Build the web app (Next.js static export -> out/)
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
# the npm download cache survives between builds, so reinstalls after dependency changes are fast
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

# Runtime: PeerPad server (serves out/) and the AI agents service (TypeScript, run directly by Node)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 NODE_NO_WARNINGS=1
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY server ./server
COPY lib ./lib
COPY mcp ./mcp
COPY --from=build /app/out ./out
VOLUME /data
EXPOSE 8787
CMD ["node", "server/server.js"]
