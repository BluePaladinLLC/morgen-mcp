# Morgen MCP hardening deploy receipt — 2026-06-25T15:45Z

Status: hardened Morgen MCP deployed on `gala-2`; read/write/delete smoke passed.

- Hostname: `morgen-mcp-234bcb06c796c734.bluepaladin.ai`
- Public MCP path: `/vYa4YjVCzqzioBwAu9ecp0z_/mcp`
- VPS: `gala-2 / 5.161.223.126`
- Service dir: `/opt/morgen-mcp`
- Backup before deploy: `/opt/morgen-mcp.before-hardening-20260625T154402Z.tgz`
- Restart: `morgen-mcp` container rebuilt/recreated; Caddy unchanged.

## Changes

- `morgenFetch` now includes sanitized upstream error details from Morgen HTTP response bodies.
- Retry set expanded for transient `429/502/503/504`, aborts, socket resets, terminated/fetch-failed errors.
- `create_event` now preflights the target time slot/title and returns an existing match instead of blindly creating a duplicate.
- If create returns an uncertain error but a matching event appears afterward, `create_event` returns that event with `recoveredAfterCreateError` rather than retrying into possible duplication.
- OAuth bridge now logs sanitized request status and redacted upstream non-2xx snippets; no request bodies, bearer tokens, API keys, or calendar payloads are logged.
- Nginx route remains reachable under app-layer OAuth for stable Claude browser/connect flows; the prior temporary auto-revert process was cancelled.

## Verification

- Local full test suite: `17 passed / 346 tests`.
- Syntax/diff checks: `node --check src/client.js`, `node --check src/tools-events.js`, `node --check src/remote-oauth-bridge.js`, and `git diff --check` passed.
- Public OAuth/MCP read smoke: `list_events` returned successfully.
- Public write smoke: created `Synapse MCP hardening smoke — delete me`, then deleted it successfully.
- Duplicate guard smoke: first create succeeded; second identical create returned `duplicateGuard=true` and same event id; cleanup delete succeeded.

## Rollback

```bash
cd /opt
tar -xzf /opt/morgen-mcp.before-hardening-20260625T154402Z.tgz
cd /opt/morgen-mcp && docker compose -f deploy/vps/docker-compose.yml --env-file .env up -d --build morgen-mcp
```
