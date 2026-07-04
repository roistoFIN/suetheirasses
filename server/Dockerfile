# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

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
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY shared/package.json shared/

RUN npm ci --omit=dev

# Copy built artifacts
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma

# Generate Prisma client
RUN npx prisma generate --schema=server/prisma/schema.prisma

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
