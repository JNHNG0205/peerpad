# Build the web app (Next.js static export -> out/)
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: sync server (serves out/) and the optional MCP server (TypeScript, run directly by Node)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 NODE_NO_WARNINGS=1
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY lib ./lib
COPY mcp ./mcp
COPY --from=build /app/out ./out
VOLUME /data
EXPOSE 8787
CMD ["node", "server/server.js"]
