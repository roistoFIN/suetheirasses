# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first for better caching
# Copy root package.json and package-lock.json
COPY package.json package-lock.json* ./

# Copy all workspace package.json files into their directories
# (this includes client/package.json and shared/package.json)
COPY client/ ./client/
COPY shared/ ./shared/

# Run npm ci to install all dependencies for all workspaces
RUN npm ci

# Build shared first, then client
WORKDIR /app/shared
RUN npm run build

# VITE_SERVER_URL is compiled into the client bundle at build time (Vite env vars are
# not readable at container runtime) — the Socket.IO client connects directly to this
# origin, so it must be the public URL the browser will actually reach, not the
# Docker-internal server:3001 address the nginx /api proxy below still uses at runtime.
ARG VITE_SERVER_URL=http://localhost:3001
ENV VITE_SERVER_URL=$VITE_SERVER_URL

# Both optional and blank-safe (see client/src/lib/googleConsent.ts) — an unset value
# means the corresponding script is never injected, regardless of visitor consent.
ARG VITE_ADSENSE_CLIENT_ID=
ENV VITE_ADSENSE_CLIENT_ID=$VITE_ADSENSE_CLIENT_ID
ARG VITE_GA_MEASUREMENT_ID=
ENV VITE_GA_MEASUREMENT_ID=$VITE_GA_MEASUREMENT_ID
ARG VITE_ADSENSE_SLOT_LANDING=
ENV VITE_ADSENSE_SLOT_LANDING=$VITE_ADSENSE_SLOT_LANDING
ARG VITE_ADSENSE_SLOT_GAMEOVER=
ENV VITE_ADSENSE_SLOT_GAMEOVER=$VITE_ADSENSE_SLOT_GAMEOVER
ARG VITE_ADSENSE_SLOT_RULES=
ENV VITE_ADSENSE_SLOT_RULES=$VITE_ADSENSE_SLOT_RULES
ARG VITE_ADSENSE_SLOT_STRATEGY=
ENV VITE_ADSENSE_SLOT_STRATEGY=$VITE_ADSENSE_SLOT_STRATEGY
ARG VITE_ADSENSE_SLOT_GLOSSARY=
ENV VITE_ADSENSE_SLOT_GLOSSARY=$VITE_ADSENSE_SLOT_GLOSSARY
ARG VITE_ADSENSE_SLOT_DEVLOG=
ENV VITE_ADSENSE_SLOT_DEVLOG=$VITE_ADSENSE_SLOT_DEVLOG
ARG VITE_ADSENSE_SLOT_HOWTOPLAY=
ENV VITE_ADSENSE_SLOT_HOWTOPLAY=$VITE_ADSENSE_SLOT_HOWTOPLAY
ARG VITE_ADSENSE_SLOT_WHATSNEW=
ENV VITE_ADSENSE_SLOT_WHATSNEW=$VITE_ADSENSE_SLOT_WHATSNEW

WORKDIR /app/client
RUN npm run build

# Production stage - serve with nginx
FROM nginx:alpine AS production

# SERVER_URL is injected at runtime via docker-compose or env file
# Defaults to http://server:3001 for Docker Compose networks
ENV SERVER_URL=http://server:3001

COPY --from=builder /app/client/dist /usr/share/nginx/html

# Custom nginx config for SPA routing with configurable upstream
# Uses __SERVER_URL__ placeholder substituted at runtime by entrypoint
RUN echo 'server { \
    listen 80; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
        try_files $uri $uri/ /index.html; \
    } \
    location /api { \
        proxy_pass __SERVER_URL__; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
        proxy_set_header X-Forwarded-Proto $scheme; \
    } \
}' > /etc/nginx/conf.d/default.conf

COPY client/nginx-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

CMD ["/docker-entrypoint.sh"]
