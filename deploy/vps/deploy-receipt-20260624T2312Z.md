# Morgen MCP VPS deploy receipt — 2026-06-24T23:12Z

Status: partially deployed on `gala-2`; local VPS service is healthy, public DNS/TLS is not complete.

- VPS: `gala-2 / 5.161.223.126`
- Access path used: Agent Vault `main-ssh-breakglass` key via fleet jump host `10.1.1.167` (`Vagus-01`); Pons jump was intermittent and Synapse direct-to-VPS SSH was unreliable.
- Service dir: `/opt/morgen-mcp`
- Runtime: Docker Compose direct on VPS, not Komodo
- Image: `morgen-mcp-bridge:0.1.0-local`
- Transport: `supergateway` wrapping upstream stdio MCP as Streamable HTTP
- Secret storage: `/opt/morgen-mcp/.env`, mode `0600`, server-side only; Morgen API key not printed or committed
- Caddy bind: `127.0.0.1:8448 -> 443`
- nginx stream relay: route inserted for the generated Morgen hostname to `morgen_mcp_proxy`; backup created as `/etc/nginx/stream-relay.conf.before-morgen-mcp-20260624T231203Z`; `nginx -t` passed and nginx reloaded
- Local app health: `http://morgen-mcp:8080/healthz -> 200 ok` from inside Docker network
- MCP smoke: Streamable HTTP tools/list and `list_calendars` succeeded from inside the container; `tool_count=15`, `calendar_count=5`, `create_event=true`
- Tests before deploy: `npm test` passed locally, 15 files / 339 tests

## Remaining public blockers

1. DNS-only A record is still required for the generated Morgen hostname to `5.161.223.126`. This Synapse lane does not currently expose Cloudflare/DNS credentials.
2. Caddy certificate issuance is pending DNS; Caddy logs currently show ACME DNS/NXDOMAIN for the generated hostname.
3. The current transport bridge does not implement the Plaid-style OAuth/DCR consent layer. It is reachable only after DNS/nginx routing, but app-layer auth should be added before broad/custom-connector exposure unless Anthropic SNI gating + random path is explicitly accepted.

## Rollback

```bash
cd /opt/morgen-mcp && docker compose --env-file .env -f deploy/vps/docker-compose.yml down
cp /etc/nginx/stream-relay.conf.before-morgen-mcp-20260624T231203Z /etc/nginx/stream-relay.conf
nginx -t && systemctl reload nginx
# remove DNS record if created
```
