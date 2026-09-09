# syntax=docker/dockerfile:1

# ---- deps: install production-capable node_modules ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Skip lifecycle scripts here: the postinstall worker-copy needs ./scripts,
# which isn't present in this stage. The worker is generated in the builder
# stage via the `prebuild` step instead.
RUN npm ci --ignore-scripts

# ---- builder: build the Next.js standalone output ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal runtime image ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# The standalone output bundles only the files needed to run the server.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
