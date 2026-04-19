# ── Stage 1: Install dependencies & build ──────────────────────────────────────
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config first (better layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./

# Copy all package.json files for workspace packages
COPY lib/db/package.json lib/db/
COPY lib/db/tsconfig.json lib/db/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/

COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/pdf-renamer/package.json artifacts/pdf-renamer/

# Install dependencies
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

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./

# Copy lib package.json files
COPY lib/db/package.json lib/db/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/

# Copy artifact package.json files
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/pdf-renamer/package.json artifacts/pdf-renamer/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built API server
COPY --from=builder /app/artifacts/api-server/dist artifacts/api-server/dist/

# Copy built frontend static files
COPY --from=builder /app/artifacts/pdf-renamer/dist/public artifacts/pdf-renamer/dist/public/

# pdf-parse is externalized from esbuild and needs to be available at runtime
# It's already installed via pnpm install above

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
