FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && npm install --global supergateway@3.4.3 \
  && npm cache clean --force

COPY --chown=node:node src ./src

USER node
EXPOSE 8080

CMD ["sh", "-lc", "supergateway --stdio 'node /app/src/index.js' --outputTransport streamableHttp --stateful --sessionTimeout ${MCP_SESSION_TIMEOUT_MS:-60000} --port ${MCP_PORT:-8080} --streamableHttpPath ${MCP_BASE_PATH:-/mcp} --healthEndpoint /healthz --logLevel ${MCP_LOG_LEVEL:-info}"]
