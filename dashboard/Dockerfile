# The read-only P&L dashboard.
#
# Build context is the REPO ROOT, not this directory -- the dashboard needs two
# things from outside itself: `prisma/schema.prisma` (the one authored schema)
# and `src/pnl/` (the P&L arithmetic, shared with the bot's test suite). Set the
# Railway service's Dockerfile path to `dashboard/Dockerfile` and leave the root
# directory at `/`.
#
# This image deliberately does NOT install the bot's dependencies. It has no
# @solana/web3.js, no Raydium SDK and no wallet -- it cannot reach the chain even
# by accident, which is the read-only guarantee expressed as a build artefact
# rather than as a promise in a comment.

FROM node:20-slim

# openssl is Prisma's requirement; ca-certificates is needed to reach Postgres
# over TLS. No Python and no build toolchain: nothing here has a native build
# step, and the root image's guard test exists to keep it that way.
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The schema first, because `npm run db:generate` copies it next to the
# dashboard's own @prisma/client and generates against that copy.
COPY prisma ./prisma/

# Dependencies before source, so a source edit does not re-run npm install.
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
WORKDIR /app/dashboard
RUN npm ci
RUN npm run db:generate

# The shared arithmetic, then the dashboard itself.
WORKDIR /app
COPY src/pnl ./src/pnl/
COPY dashboard ./dashboard/

WORKDIR /app/dashboard
RUN npm run typecheck
RUN npm run build

# Fail the build rather than serve a blank page: `npm start` serves
# web/dist statically, and a missing bundle would 404 at runtime on a
# deploy that otherwise looked green.
RUN test -f web/dist/index.html && echo "web bundle present"

# No EXPOSE and no fixed port: Railway injects PORT and the server reads it.
CMD ["npm", "start"]
