FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
COPY --from=build /build/package.json /build/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist/ dist/
USER appuser
# Inside a container the server must listen on all interfaces, or published
# ports cannot reach it. A non-loopback bind is refused unless explicitly opted
# into (issue #43), so the image opts in here, deliberately. The image does NOT
# opt out of authentication: the operator must set MCP_AUTH_TOKEN_FILE (or
# MCP_AUTH_TOKEN), or explicitly set MCP_ALLOW_UNAUTHENTICATED=true.
ENV HOST=0.0.0.0 \
    MCP_ALLOW_NON_LOOPBACK=true
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
