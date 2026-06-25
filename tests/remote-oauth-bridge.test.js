import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { createBridgeServer, verifyPkce } from "../src/remote-oauth-bridge.js";

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const servers = [];

afterEach(async () => {
  while (servers.length) {
    await close(servers.pop());
  }
});

describe("remote OAuth bridge", () => {
  it("publishes OAuth metadata and completes DCR + PKCE authorization flow", async () => {
    const upstream = http.createServer((req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proxied: true, method: req.method, url: req.url }));
    });
    const upstreamOrigin = await listen(upstream);
    servers.push(upstream);

    const bridge = createBridgeServer({ upstreamOrigin, basePath: "/secret/mcp" });
    const bridgeOrigin = await listen(bridge);
    servers.push(bridge);

    const forwarded = { "x-forwarded-proto": "http" };
    const unauth = await fetch(`${bridgeOrigin}/secret/mcp`, { method: "POST", headers: forwarded });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("oauth-protected-resource");

    const protectedResource = await fetch(`${bridgeOrigin}/.well-known/oauth-protected-resource`, { headers: forwarded });
    expect(await protectedResource.json()).toMatchObject({
      resource: `${bridgeOrigin}/secret/mcp`,
      authorization_servers: [bridgeOrigin],
    });

    const authServer = await fetch(`${bridgeOrigin}/.well-known/oauth-authorization-server`, { headers: forwarded });
    expect(await authServer.json()).toMatchObject({
      issuer: bridgeOrigin,
      authorization_endpoint: `${bridgeOrigin}/oauth/authorize`,
      token_endpoint: `${bridgeOrigin}/oauth/token`,
      registration_endpoint: `${bridgeOrigin}/oauth/register`,
    });

    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const registration = await fetch(`${bridgeOrigin}/oauth/register`, {
      method: "POST",
      headers: { ...forwarded, "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri] }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json();
    expect(registered.client_id).toMatch(/^mcp_client_/);
    expect(registered.token_endpoint_auth_method).toBe("none");

    const verifier = "correct horse battery staple";
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const authUrl = new URL(`${bridgeOrigin}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", registered.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", "state-1");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const auth = await fetch(authUrl, { redirect: "manual", headers: forwarded });
    expect(auth.status).toBe(302);
    const location = new URL(auth.headers.get("location"));
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("state")).toBe("state-1");
    const code = location.searchParams.get("code");
    expect(code).toMatch(/^mcp_code_/);

    const token = await fetch(`${bridgeOrigin}/oauth/token`, {
      method: "POST",
      headers: { ...forwarded, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = await token.json();
    expect(tokenBody.access_token).toMatch(/^mcp_at_/);
    expect(tokenBody.refresh_token).toMatch(/^mcp_rt_/);

    const proxied = await fetch(`${bridgeOrigin}/secret/mcp`, {
      method: "POST",
      headers: {
        ...forwarded,
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({ proxied: true, method: "POST", url: "/secret/mcp" });
  });

  it("logs upstream HTTP errors without exposing bearer tokens", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = http.createServer((req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad session", token: req.headers.authorization || "none" }));
    });
    const upstreamOrigin = await listen(upstream);
    servers.push(upstream);

    const bridge = createBridgeServer({ upstreamOrigin, basePath: "/secret/mcp" });
    const bridgeOrigin = await listen(bridge);
    servers.push(bridge);

    const registration = await fetch(`${bridgeOrigin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "http" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    const registered = await registration.json();
    const verifier = "verifier";
    const authUrl = new URL(`${bridgeOrigin}/oauth/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", registered.client_id);
    authUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
    authUrl.searchParams.set("code_challenge", verifier);
    authUrl.searchParams.set("code_challenge_method", "plain");
    const auth = await fetch(authUrl, { redirect: "manual", headers: { "x-forwarded-proto": "http" } });
    const code = new URL(auth.headers.get("location")).searchParams.get("code");
    const token = await fetch(`${bridgeOrigin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "http" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code,
        code_verifier: verifier,
      }),
    });
    const tokenBody = await token.json();

    const proxied = await fetch(`${bridgeOrigin}/secret/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });

    expect(proxied.status).toBe(400);
    const logs = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logs).toContain("upstream_error");
    expect(logs).toContain("bad session");
    expect(logs).not.toContain(tokenBody.access_token);
    errorSpy.mockRestore();
  });

  it("verifies S256 and plain PKCE challenges", () => {
    const verifier = "verifier";
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    expect(verifyPkce({ codeChallenge: challenge, method: "S256", verifier })).toBe(true);
    expect(verifyPkce({ codeChallenge: challenge, method: "S256", verifier: "wrong" })).toBe(false);
    expect(verifyPkce({ codeChallenge: verifier, method: "plain", verifier })).toBe(true);
  });
});
