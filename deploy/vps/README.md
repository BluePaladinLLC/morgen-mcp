# VPS MCP bridge deployment notes

This repo should follow the existing direct-VPS MCP bridge pattern used for GitHub/Plaid MCP, not Komodo.

## Target pattern

- Host: `gala-2 / 5.161.223.126` unless Bruno assigns a replacement VPS.
- Service dir: `/opt/morgen-mcp`.
- Runtime: Docker Compose managed directly on the VPS.
- Internal app: `morgen-mcp` container exposes Streamable HTTP MCP on `:8080` using `supergateway` around the upstream stdio server.
- Local TLS hop: Caddy binds `127.0.0.1:8447:443` and reverse-proxies to `morgen-mcp:8080`.
- Public edge: existing nginx stream SNI relay on `:443` routes `morgen-mcp-<token>.bluepaladin.ai` to `127.0.0.1:8447` and hard-blocks non-Anthropic egress via the existing `blocked_mcp_proxy` pattern.
- Secrets: `.env` is created server-side only, mode `0600`, never committed.

## Required server-side `.env`

```bash
MORGEN_MCP_HOSTNAME=morgen-mcp-<token>.bluepaladin.ai
CADDY_BIND_PORT=8447
MCP_BASE_PATH=/<random-path>/mcp
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
   - `curl -k https://127.0.0.1:8447/healthz --resolve "$MORGEN_MCP_HOSTNAME:8447:127.0.0.1"`
   - MCP tools/list smoke against `https://127.0.0.1:8447$MCP_BASE_PATH` from inside/near the VPS.
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

## Current blockers

- Bruno must supply/approve the Morgen API key lane.
- Bruno must approve hostname/path/token choices.
- Synapse currently cannot reach `5.161.223.126:22` from this runtime (`Connection timed out`). Deployment needs an SSH path to `gala-2`, an approved helper lane, or a human/agent already on that VPS to run the prepared `/opt/morgen-mcp` compose bundle.
- If this must be a Claude custom connector, add the OAuth/DCR layer used in Plaid before public rollout; `supergateway` alone provides Streamable HTTP transport but not the full Plaid-style OAuth consent flow.
