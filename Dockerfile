FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Copy manifests first so dependency installation stays cacheable.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/cli/package.json apps/cli/
COPY apps/ingestion/package.json apps/ingestion/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/scraper/package.json apps/scraper/
COPY packages/types/package.json packages/types/
COPY packages/db/package.json packages/db/
COPY packages/vector/package.json packages/vector/
COPY packages/core/package.json packages/core/
RUN bun install --frozen-lockfile --ignore-scripts

COPY python/requirements.txt python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/ingestion/ apps/ingestion/
COPY apps/mcp-server/ apps/mcp-server/
COPY python/ python/
COPY scripts/ scripts/

ENV MCP_TRANSPORT=http
EXPOSE 3000 3001

CMD ["bun", "run", "apps/mcp-server/src/index.ts"]
