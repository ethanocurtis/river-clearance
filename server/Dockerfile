FROM node:20-slim

# better-sqlite3 needs to compile a native addon; git is for gitSync.js
# (auto-committing admin data edits -- see REPO_DIR/GIT_PUSH_TOKEN in README).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
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
