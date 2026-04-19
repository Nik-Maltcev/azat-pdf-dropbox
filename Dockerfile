# ── Stage 1: Install dependencies & build ──────────────────────────────────────
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config first (better layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./

# Copy all package.json files for workspace packages
COPY lib/db/package.json lib/db/tsconfig.json lib/db/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-spec/package.json lib/api-spec/

COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/pdf-renamer/package.json artifacts/pdf-renamer/
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/

COPY scripts/package.json scripts/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/
COPY artifacts/pdf-renamer/ artifacts/pdf-renamer/

# Build frontend (static files)
ENV PORT=5173
ENV BASE_PATH=/
RUN pnpm --filter @workspace/pdf-renamer run build

# Build API server
RUN pnpm --filter @workspace/api-server run build

# ── Stage 2: Production image ──────────────────────────────────────────────────
FROM node:20-slim AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy everything from builder (simpler, avoids workspace resolution issues)
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/.npmrc ./
COPY --from=builder /app/tsconfig.base.json /app/tsconfig.json ./
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/lib ./lib/
COPY --from=builder /app/artifacts/api-server/package.json ./artifacts/api-server/
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules/
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist/
COPY --from=builder /app/artifacts/pdf-renamer/package.json ./artifacts/pdf-renamer/
COPY --from=builder /app/artifacts/pdf-renamer/dist/public ./artifacts/pdf-renamer/dist/public/
COPY --from=builder /app/artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
