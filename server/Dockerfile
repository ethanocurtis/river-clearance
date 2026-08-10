FROM node:20-slim

# better-sqlite3 needs to compile a native addon; git is for gitSync.js
# (auto-committing admin data edits -- see REPO_DIR/GIT_PUSH_TOKEN in README).
# ca-certificates is required for git's own HTTPS push to verify GitHub's TLS
# cert -- node:20-slim doesn't include it by default, and without it `git
# push` over https fails with "server certificate verification failed" even
# though everything else (including this app's own HTTPS/TLS calls, which go
# through Node's bundled CA store instead of the OS one) works fine.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8787
ENV DB_PATH=/data/sync.sqlite3
VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server.js"]
