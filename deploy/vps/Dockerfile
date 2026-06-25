FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && npm install --global supergateway@3.4.3 \
  && npm cache clean --force

COPY --chown=node:node src ./src

USER node
EXPOSE 8080

CMD ["node", "/app/src/remote-oauth-bridge.js"]
