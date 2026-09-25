FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/app/data

WORKDIR /app

# Install only production dependencies first so this layer stays cacheable.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The application is intentionally copied without tests, local data or secrets.
COPY src ./src
COPY public ./public
COPY chat-public ./chat-public

# SQLite metrics and settings must survive container redeploys through a Coolify volume.
RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

# Coolify should publish the gateway port. The admin app remains internal by default;
# its dashboard is also available through the authenticated /dashboard route.
EXPOSE 3401

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
