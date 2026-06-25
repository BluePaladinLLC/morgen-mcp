# Morgen MCP bridge deploy receipt — 2026-06-25T03:18Z

Status: deployed on `gala-2`; DNS and TLS are live; public SNI relay restored to Anthropic-gated posture.

- Hostname: `morgen-mcp-234bcb06c796c734.bluepaladin.ai`
- Public path: `/vYa4YjVCzqzioBwAu9ecp0z_/mcp`
- VPS: `gala-2 / 5.161.223.126`
- Service dir: `/opt/morgen-mcp`
- MCP implementation: pinned `fidgetcoding/morgen-mcp` fork with env-configured account routing; stdio wrapped with `supergateway` Streamable HTTP
- Container image: `morgen-mcp-bridge:0.1.0-local`
- Secret storage: `/opt/morgen-mcp/.env` server-side only; key values not recorded
- Calendar smoke: Morgen API key verified; 5 calendars visible; local MCP smoke listed 15 tools and `list_calendars` succeeded
- Routing defaults: `bruno` default; `work` routes `@marcmansolutions.com`; `epik` routes `2Epik`; `family` routes `Family`
- Backend exposure: Docker network only; Caddy bound on `127.0.0.1:8448`
- Edge routing: nginx stream SNI maps `morgen-mcp-234bcb06c796c734.bluepaladin.ai:1` to `morgen_mcp_proxy`; `:0` restored to `blocked_mcp_proxy`
- DNS: Cloudflare DNS-only A record created: `morgen-mcp-234bcb06c796c734.bluepaladin.ai -> 5.161.223.126`
- TLS: Let's Encrypt certificate obtained after bounded temporary ACME allow window; stream relay backup created at `/etc/nginx/stream-relay.conf.before-morgen-acme-20260625T031718Z`; relay restored and `nginx -t` passed
- Health: trusted local Caddy loopback health via `--connect-to ...127.0.0.1:8448` returned `200` with body `ok`
- Caveat: public health from Synapse/non-Anthropic egress is expected to fail because SNI relay blocks non-Anthropic clients for this host

## Rollback

```bash
cd /opt/morgen-mcp && docker compose -f deploy/vps/docker-compose.yml --env-file .env down
cp -a /etc/nginx/stream-relay.conf.before-morgen-acme-20260625T031718Z /etc/nginx/stream-relay.conf
nginx -t && systemctl reload nginx
# Remove DNS record if retiring the hostname
```
