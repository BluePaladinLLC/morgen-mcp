export const MORGEN_BASE = "https://api.morgen.so";

// Raised from 100 → 300 on 2026-04-15 per John Mavrick @ Morgen
// ("other users hitting limits quickly"). The constant lives here because
// Morgen has no public endpoint exposing the current budget.
const RATE_LIMIT_POINTS = 300;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// Rolling window of { timestamp, points } entries
let pointLedger = [];

function pruneLedger(now) {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  pointLedger = pointLedger.filter((entry) => entry.timestamp > cutoff);
}

function currentPoints() {
  return pointLedger.reduce((sum, entry) => sum + entry.points, 0);
}

// Walk the ledger to find the earliest moment enough old points expire
// for the incoming request to fit within the budget. A 10-point list call
// with only 5 free points needs to wait until multiple old entries drop off,
// not just the oldest one.
function msUntilFits(now, incomingPoints) {
  const overBy = currentPoints() + incomingPoints - RATE_LIMIT_POINTS;
  if (overBy <= 0) return 0;
  let released = 0;
  for (const entry of pointLedger) {
    released += entry.points;
    if (released >= overBy) {
      const expiryTime = entry.timestamp + RATE_LIMIT_WINDOW_MS;
      return Math.max(0, expiryTime - now);
    }
  }
  return RATE_LIMIT_WINDOW_MS;
}

function enforceRateLimit(points) {
  if (points > RATE_LIMIT_POINTS) {
    throw new Error(
      `request requires ${points} points but the Morgen rate limit budget is only ${RATE_LIMIT_POINTS} points per 15 minutes`
    );
  }
  const now = Date.now();
  pruneLedger(now);

  if (currentPoints() + points > RATE_LIMIT_POINTS) {
    const msUntilExpiry = msUntilFits(now, points);
    const secondsUntilExpiry = Math.max(1, Math.ceil(msUntilExpiry / 1000));
    throw new Error(
      `Morgen rate limit reached (300 points per 15 minutes). Try again in ${secondsUntilExpiry} seconds.`
    );
  }

  pointLedger.push({ timestamp: now, points });
}

export function _resetRateLimiter() {
  pointLedger = [];
}

function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function withRetry(fn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = Number(err?.status || 0);
      const message = String(err?.message || "");
      const isRetryable =
        [429, 502, 503, 504].includes(status) ||
        err.name === "AbortError" ||
        (message && (
          message.includes("HTTP 429") ||
          message.includes("HTTP 502") ||
          message.includes("HTTP 503") ||
          message.includes("HTTP 504") ||
          message.includes("fetch failed") ||
          message.includes("socket") ||
          message.includes("ECONNRESET") ||
          message.includes("terminated")
        ));
      if (!isRetryable || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  throw lastError;
}

function morgenHeaders() {
  const apiKey = process.env.MORGEN_API_KEY;
  return {
    Authorization: `ApiKey ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function scrubKey(message) {
  const key = process.env.MORGEN_API_KEY;
  if (!message) return message;
  let scrubbed = message.replace(/https?:\/\/[^\s)]+/g, "[redacted-url]");
  if (key && key.length > 4) {
    scrubbed = scrubbed.split(key).join("[redacted-key]");
  }
  return scrubbed;
}

async function readErrorBody(res) {
  try {
    if (typeof res.text === "function") return await res.text();
  } catch {}
  try {
    if (typeof res.json === "function") return JSON.stringify(await res.json());
  } catch {}
  return "";
}

function summarizeErrorBody(bodyText) {
  if (!bodyText) return "";
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (typeof parsed === "string") return parsed;
  if (parsed?.message) return String(parsed.message);
  if (parsed?.error_description) return String(parsed.error_description);
  if (parsed?.error) return typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
  return JSON.stringify(parsed);
}

export async function morgenFetch(path, { method = "GET", body, points = 1 } = {}) {
  enforceRateLimit(points);

  try {
    return await withRetry(async () => {
      const init = {
        method,
        headers: morgenHeaders(),
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const res = await fetchWithTimeout(`${MORGEN_BASE}${path}`, init);

      if (!res.ok) {
        const bodyText = await readErrorBody(res);
        const detail = summarizeErrorBody(bodyText);
        const err = new Error(
          `Morgen API error (HTTP ${res.status}) on ${path}` +
            (detail ? `: ${detail}` : ". The request was not successful.")
        );
        err.status = res.status;
        throw err;
      }

      if (
        res.status === 204 ||
        res.status === 205 ||
        res.headers.get("content-length") === "0"
      ) {
        return null;
      }

      return res.json();
    });
  } catch (err) {
    const safe = scrubKey(err instanceof Error ? err.message : String(err));
    const out = new Error((safe || "Morgen API call failed").slice(0, 1200));
    if (err?.status) out.status = err.status;
    throw out;
  }
}
