#!/usr/bin/env node
// Remote MCP OAuth/DCR bridge for Claude custom connectors.
//
// The upstream Morgen MCP server is stdio-only; in production we wrap it with
// supergateway's Streamable HTTP transport, then place this tiny OAuth 2.1 / DCR
// resource server in front of it. Secrets stay server-side; Claude receives only
// short-lived opaque bearer tokens for this bridge.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";

const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 8;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function randomToken(prefix = "") {
  return `${prefix}${b64url(randomBytes(32))}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyPkce({ codeChallenge, method = "plain", verifier }) {
  if (!codeChallenge) return true;
  if (!verifier) return false;
  if (method === "S256") {
    return safeEqual(b64url(createHash("sha256").update(verifier).digest()), codeChallenge);
  }
  if (method === "plain") {
    return safeEqual(verifier, codeChallenge);
  }
  return false;
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,mcp-session-id,mcp-protocol-version",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...extraHeaders,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  res.end();
}

function logEvent(payload) {
  try {
    console.error(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
  } catch {
    // Logging must never affect the bridge path.
  }
}

function scrubForLog(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/ApiKey\s+[A-Za-z0-9._~+\/-]+/gi, "ApiKey [REDACTED]")
    .replace(/mcp_(?:at|rt|code|client)_[A-Za-z0-9._~+\/-]+/g, "mcp_[REDACTED]")
    .replace(/https?:\/\/[^\s)\"]+/g, "[redacted-url]")
    .slice(0, 800);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseRequestBody(req) {
  const raw = await readBody(req);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!raw.trim()) return {};
  if (contentType.includes("application/json")) {
    return JSON.parse(raw);
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function normalizedBasePath(value) {
  let path = String(value || "/mcp").trim() || "/mcp";
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/+$/, "") || "/mcp";
}

function publicBaseUrl(req, configuredBaseUrl) {
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

export function buildOAuthMetadata({ issuer }) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

export function buildProtectedResourceMetadata({ issuer, resource }) {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_documentation: `${issuer}/`,
  };
}

export function createBridgeServer(options = {}) {
  const clients = new Map();
  const authCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();

  const basePath = normalizedBasePath(options.basePath ?? process.env.MCP_BASE_PATH);
  const configuredPublicBaseUrl = (options.publicBaseUrl ?? process.env.MCP_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const upstreamOrigin = (options.upstreamOrigin ?? `http://127.0.0.1:${process.env.MCP_UPSTREAM_PORT || 8090}`).replace(/\/+$/, "");
  const tokenTtlSeconds = Number(options.tokenTtlSeconds ?? process.env.OAUTH_TOKEN_TTL_SECONDS ?? DEFAULT_TOKEN_TTL_SECONDS);
  const refreshTtlSeconds = Number(options.refreshTtlSeconds ?? process.env.OAUTH_REFRESH_TTL_SECONDS ?? DEFAULT_REFRESH_TTL_SECONDS);

  function makeToken(clientId) {
    const accessToken = randomToken("mcp_at_");
    const refreshToken = randomToken("mcp_rt_");
    const now = Date.now();
    accessTokens.set(accessToken, {
      clientId,
      expiresAt: now + tokenTtlSeconds * 1000,
    });
    refreshTokens.set(refreshToken, {
      clientId,
      expiresAt: now + refreshTtlSeconds * 1000,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: tokenTtlSeconds,
      refresh_token: refreshToken,
      scope: "mcp",
    };
  }

  function validateBearer(req) {
    const header = String(req.headers.authorization || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const record = accessTokens.get(match[1]);
    if (!record) return false;
    if (record.expiresAt < Date.now()) {
      accessTokens.delete(match[1]);
      return false;
    }
    return true;
  }

  function oauthRequired(req, res, baseUrl) {
    const resourceMetadata = `${baseUrl}/.well-known/oauth-protected-resource`;
    json(
      res,
      401,
      { error: "unauthorized", error_description: "OAuth bearer token required" },
      { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"` }
    );
  }

  async function proxyToUpstream(req, res) {
    const target = new URL(req.url, upstreamOrigin);
    const headers = { ...req.headers, host: target.host };
    // The upstream supergateway is local and does not need our OAuth token.
    delete headers.authorization;

    const upstreamReq = http.request(
      target,
      {
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        responseHeaders["access-control-allow-origin"] = "*";
        const statusCode = upstreamRes.statusCode || 502;
        if (statusCode >= 400) {
          const chunks = [];
          upstreamRes.on("data", (chunk) => chunks.push(chunk));
          upstreamRes.on("end", () => {
            const body = Buffer.concat(chunks);
            logEvent({
              event: "upstream_error",
              status: statusCode,
              path: target.pathname,
              body: scrubForLog(body.toString("utf8")),
            });
            res.writeHead(statusCode, responseHeaders);
            res.end(body);
          });
          return;
        }
        res.writeHead(statusCode, responseHeaders);
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on("error", (err) => {
      json(res, 502, { error: "bad_gateway", error_description: err.message });
    });
    req.pipe(upstreamReq);
  }

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestPath = (() => {
      try {
        return new URL(req.url || "/", "http://local").pathname;
      } catch {
        return req.url || "";
      }
    })();
    res.on("finish", () => {
      logEvent({
        event: "http_request",
        method: req.method,
        path: requestPath,
        status: res.statusCode,
        authorization_present: Boolean(req.headers.authorization),
        user_agent: String(req.headers["user-agent"] || "").slice(0, 160),
        duration_ms: Date.now() - startedAt,
      });
    });
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "authorization,content-type,mcp-session-id,mcp-protocol-version",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }

      const baseUrl = publicBaseUrl(req, configuredPublicBaseUrl);
      const url = new URL(req.url || "/", baseUrl);
      const resource = `${baseUrl}${basePath}`;

      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
        text(res, 200, "ok");
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(res, 200, buildProtectedResourceMetadata({ issuer: baseUrl, resource }));
        return;
      }

      if (
        req.method === "GET" &&
        (url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
          url.pathname === "/.well-known/openid-configuration")
      ) {
        json(res, 200, buildOAuthMetadata({ issuer: baseUrl }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/oauth/register") {
        const body = await parseRequestBody(req);
        const clientId = randomToken("mcp_client_");
        clients.set(clientId, {
          clientId,
          clientName: body.client_name || "MCP client",
          redirectUris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
          createdAt: Date.now(),
        });
        json(res, 201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: body.client_name || "MCP client",
          redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        const clientId = url.searchParams.get("client_id");
        const redirectUri = url.searchParams.get("redirect_uri");
        const responseType = url.searchParams.get("response_type");
        const state = url.searchParams.get("state") || "";
        const codeChallenge = url.searchParams.get("code_challenge") || "";
        const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "plain";
        const client = clients.get(clientId);
        if (!client || responseType !== "code" || !redirectUri) {
          json(res, 400, { error: "invalid_request" });
          return;
        }
        if (client.redirectUris.length && !client.redirectUris.includes(redirectUri)) {
          json(res, 400, { error: "invalid_redirect_uri" });
          return;
        }
        const code = randomToken("mcp_code_");
        authCodes.set(code, {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        const redirectTarget = new URL(redirectUri);
        redirectTarget.searchParams.set("code", code);
        if (state) redirectTarget.searchParams.set("state", state);
        redirect(res, redirectTarget.toString());
        return;
      }

      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const body = await parseRequestBody(req);
        if (body.grant_type === "authorization_code") {
          const record = authCodes.get(body.code);
          if (!record || record.expiresAt < Date.now()) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          if (body.client_id && body.client_id !== record.clientId) {
            json(res, 400, { error: "invalid_client" });
            return;
          }
          if (body.redirect_uri && body.redirect_uri !== record.redirectUri) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          if (!verifyPkce({
            codeChallenge: record.codeChallenge,
            method: record.codeChallengeMethod,
            verifier: body.code_verifier,
          })) {
            json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
            return;
          }
          authCodes.delete(body.code);
          json(res, 200, makeToken(record.clientId));
          return;
        }
        if (body.grant_type === "refresh_token") {
          const record = refreshTokens.get(body.refresh_token);
          if (!record || record.expiresAt < Date.now()) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          json(res, 200, makeToken(record.clientId));
          return;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      if (url.pathname === "/") {
        text(res, 200, "Morgen MCP OAuth bridge ok");
        return;
      }

      if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) {
        if (!validateBearer(req)) {
          oauthRequired(req, res, baseUrl);
          return;
        }
        await proxyToUpstream(req, res);
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      json(res, 500, { error: "internal_error", error_description: err.message });
    }
  });

  server.bridgeState = { clients, authCodes, accessTokens, refreshTokens, basePath, upstreamOrigin };
  return server;
}

export function spawnSupergateway() {
  const upstreamPort = process.env.MCP_UPSTREAM_PORT || "8090";
  const basePath = normalizedBasePath(process.env.MCP_BASE_PATH);
  const sessionTimeout = process.env.MCP_SESSION_TIMEOUT_MS || "60000";
  const logLevel = process.env.MCP_LOG_LEVEL || "info";
  const stdioCommand = process.env.MCP_STDIO_COMMAND || "node /app/src/index.js";
  const bin = process.env.SUPERGATEWAY_BIN || "supergateway";
  const args = [
    "--stdio", stdioCommand,
    "--outputTransport", "streamableHttp",
    "--stateful",
    "--sessionTimeout", sessionTimeout,
    "--port", upstreamPort,
    "--streamableHttpPath", basePath,
    "--healthEndpoint", "/healthz",
    "--logLevel", logLevel,
  ];
  const child = spawn(bin, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.error(`supergateway exited code=${code ?? ""} signal=${signal ?? ""}`);
    process.exitCode = code || 1;
    process.exit(process.exitCode);
  });
  return child;
}

export function startBridge() {
  const port = Number(process.env.MCP_PORT || 8080);
  const host = process.env.MCP_BIND_HOST || "0.0.0.0";
  const child = process.env.MCP_SKIP_SUPERGATEWAY === "true" ? null : spawnSupergateway();
  const server = createBridgeServer();
  server.listen(port, host, () => {
    console.error(`Morgen MCP OAuth bridge listening on ${host}:${port}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    if (child) child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { server, child };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBridge();
}
