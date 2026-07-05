#!/bin/sh
# Substitute SERVER_URL env var into nginx config at container startup
sed -i "s|__SERVER_URL__|${SERVER_URL:-http://server:3001}|g" /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
