# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json* ./
COPY client/package.json client/
COPY shared/package.json shared/

RUN npm ci

# Copy source code
COPY client/ ./client/
COPY shared/ ./shared/

# Build shared first, then client
WORKDIR /app/shared
RUN npm run build

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

CMD ["nginx", "-g", "daemon off;"]
