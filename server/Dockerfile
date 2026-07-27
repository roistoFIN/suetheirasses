# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Install OpenSSL for Prisma compatibility
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better caching
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY shared/package.json shared/

RUN npm ci

# Copy source code
COPY server/ ./server/
COPY shared/ ./shared/

# Build shared first, then server
WORKDIR /app/shared
RUN npm run build

WORKDIR /app/server
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npm run build

# Production stage
FROM node:22-slim AS production

WORKDIR /app

# Install OpenSSL for Prisma compatibility
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install production dependencies only
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY shared/package.json shared/

RUN npm ci --omit=dev

# Copy built artifacts
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma

# prisma/seed.ts is TypeScript run directly via tsx (not compiled by `tsc build` — it
# lives outside server/tsconfig.json's "src/**/*" include glob) and imports
# ../src/data/*.json + ../src/engine/defaultFormulas.js (resolved by tsx against the
# sibling .ts source, not dist) — so `npm run db:seed`/`npx tsx server/prisma/seed.ts`
# needs the real server/src tree present here, not just the compiled dist output.
COPY --from=builder /app/server/src ./server/src

# Generate Prisma client
RUN npx prisma generate --schema=server/prisma/schema.prisma

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
