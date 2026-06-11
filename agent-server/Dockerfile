FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# codex backend. server.js depends on the `codex exec --json` thread/turn event
# schema (thread.started / item.completed / turn.completed); pin if it drifts.
ARG CODEX_VERSION=latest
RUN npm install -g @openai/codex@${CODEX_VERSION}

COPY package.json ./
COPY server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV HOME=/tmp
ENTRYPOINT ["/app/entrypoint.sh"]
