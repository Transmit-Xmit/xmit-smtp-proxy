FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove dev dependencies and source
RUN rm -rf src tsconfig.json
RUN npm prune --production

# Run as non-root user
RUN addgroup -g 1001 -S smtp && adduser -u 1001 -S smtp -G smtp
USER smtp

# Default port
EXPOSE 587

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('net').connect(587, 'localhost').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
