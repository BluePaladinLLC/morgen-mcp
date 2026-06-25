# VPS MCP bridge deployment notes

This repo should follow the existing direct-VPS MCP bridge pattern used for GitHub/Plaid MCP, not Komodo.

## Target pattern

- Host: `gala-2 / 5.161.223.126` unless Bruno assigns a replacement VPS.
- Service dir: `/opt/morgen-mcp`.
- Runtime: Docker Compose managed directly on the VPS.
- Internal app: `morgen-mcp` container exposes an OAuth/DCR-protected Streamable HTTP MCP on `:8080`; it starts `supergateway` internally on `:8090` around the upstream stdio server.
- Local TLS hop: Caddy binds `127.0.0.1:8448:443` and reverse-proxies to `morgen-mcp:8080`.
- Public edge: existing nginx stream SNI relay on `:443` routes `morgen-mcp-<token>.bluepaladin.ai` to `127.0.0.1:8448` and hard-blocks non-Anthropic egress via the existing `blocked_mcp_proxy` pattern.
- Secrets: `.env` is created server-side only, mode `0600`, never committed.

## Required server-side `.env`

```bash
MORGEN_MCP_HOSTNAME=morgen-mcp-<token>.bluepaladin.ai
CADDY_BIND_PORT=8448
MCP_BASE_PATH=/<random-path>/mcp
MCP_PUBLIC_BASE_URL=https://morgen-mcp-<token>.bluepaladin.ai
MCP_LOG_LEVEL=none
MORGEN_API_KEY=<server-side-only>
MORGEN_TIMEZONE=America/New_York
MORGEN_SELF_EMAIL=bruno.sousa@marcmansolutions.com
MORGEN_DEFAULT_ACCOUNT=bruno
MORGEN_ACCOUNT_ROUTES='{"bruno":{"calendar_patterns":["Bruno"]},"work":{"domains":["@marcmansolutions.com"],"calendar_patterns":["bruno.sousa@marcmansolutions.com"]},"epik":{"calendar_patterns":["2Epik"]},"family":{"calendar_patterns":["Family"]}}'
```

## Deployment sequence

1. Build/copy repo contents to `/opt/morgen-mcp` on the VPS.
2. Create `/opt/morgen-mcp/.env` from the secret lane; do not echo values into logs.
3. `cd /opt/morgen-mcp && docker compose -f deploy/vps/docker-compose.yml up -d --build`.
4. Validate locally on VPS:
   - `docker compose -f deploy/vps/docker-compose.yml ps`
   - `curl -k https://127.0.0.1:8448/healthz --resolve "$MORGEN_MCP_HOSTNAME:8448:127.0.0.1"`
   - OAuth metadata smoke: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, DCR register, authorize, token.
   - MCP tools/list smoke against `https://127.0.0.1:8448$MCP_BASE_PATH` from inside/near the VPS using the OAuth bearer token.
5. Add DNS-only A record for `$MORGEN_MCP_HOSTNAME -> 5.161.223.126`.
6. Patch `/etc/nginx/stream-relay.conf` using `deploy/vps/stream-relay.snippet.conf`; run `nginx -t && systemctl reload nginx`.
7. Public smoke: health endpoint, unauthenticated MCP posture, and authenticated/connector tool list if auth layer is added.

## Rollback

```bash
cd /opt/morgen-mcp && docker compose -f deploy/vps/docker-compose.yml down
# restore /etc/nginx/stream-relay.conf from timestamped backup, then:
nginx -t && systemctl reload nginx
# remove DNS record if created
```

## Deployment receipt

Current deployed receipt: `deploy/vps/deploy-receipt-20260625T0318Z.md`.

- DNS is live: `morgen-mcp-234bcb06c796c734.bluepaladin.ai -> 5.161.223.126`.
- TLS is live on the loopback Caddy hop; nginx stream SNI relay is restored to Anthropic-gated posture.
- Claude custom connector support requires the OAuth/DCR bridge in `src/remote-oauth-bridge.js`; `supergateway` remains the internal Streamable HTTP transport.
