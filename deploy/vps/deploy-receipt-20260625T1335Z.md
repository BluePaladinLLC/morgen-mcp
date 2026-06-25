# Morgen MCP OAuth bridge deploy receipt — 2026-06-25T13:35Z

Status: OAuth/DCR bridge deployed on `gala-2`; Claude custom-connector discovery endpoints are live on the trusted loopback/Caddy path.

- Hostname: `morgen-mcp-234bcb06c796c734.bluepaladin.ai`
- Public path: `/vYa4YjVCzqzioBwAu9ecp0z_/mcp`
- VPS: `gala-2 / 5.161.223.126`
- Service dir: `/opt/morgen-mcp`
- Change: `src/remote-oauth-bridge.js` now fronts the Streamable HTTP MCP with OAuth 2.1-style discovery, Dynamic Client Registration, authorization-code + PKCE, refresh tokens, and bearer-token enforcement.
- Internal transport: bridge listens on `:8080`; `supergateway` now runs inside the same container on `:8090` and wraps `node /app/src/index.js`.
- Secret storage: `/opt/morgen-mcp/.env` server-side only; key values not recorded.
- Backups before deploy: `/opt/morgen-mcp.before-oauth-20260625T132926Z.tgz`; after rebase redeploy: `/opt/morgen-mcp.before-rebased-oauth-20260625T133652Z.tgz`.
- Restart: `morgen-mcp` container rebuilt/recreated twice (OAuth deploy, then rebased redeploy); Caddy and nginx stream relay were not changed.
- Local tests before deploy: `npm test` passed — 16 files / 341 tests; `node --check src/remote-oauth-bridge.js` and `git diff --check` passed.
- VPS health: local trusted Caddy `GET /healthz` returned `ok`.
- OAuth metadata: local trusted Caddy returned valid `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` JSON with issuer `https://morgen-mcp-234bcb06c796c734.bluepaladin.ai`.
- OAuth + MCP smoke: DCR register, authorize, token exchange, SDK Streamable HTTP connect, `listTools`, and `list_calendars` all succeeded from inside the container; `tool_count=15`, `calendar_count=5`.
- Security posture: public non-Anthropic/Synapse egress is still expected to fail at the nginx SNI gate; app-layer OAuth is now present for Claude connector flows that pass the gate.
- Logging posture: `MCP_LOG_LEVEL=none`; old Docker JSON logs were checked for exact Morgen key exposure (none found) and truncated after successful smoke tests to remove prior verbose tool payloads.

## Rollback

```bash
cd /opt
# Restore source/deploy files from the pre-OAuth archive, preserving /opt/morgen-mcp/.env separately.
tar -xzf /opt/morgen-mcp.before-oauth-20260625T132926Z.tgz
cd /opt/morgen-mcp && docker compose -f deploy/vps/docker-compose.yml --env-file .env up -d --build morgen-mcp
```
