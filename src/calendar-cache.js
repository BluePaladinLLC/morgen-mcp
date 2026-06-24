// Cached calendar directory. Every write endpoint in Morgen's API requires
// both `calendarId` AND `accountId`, so we need to look up the accountId for
// a given calendarId. Hitting /v3/calendars/list costs 10 rate points, so we
// cache the whole result for 10 minutes.
import { morgenFetch } from "./client.js";
import { unwrapCalendars } from "./events-shape.js";

const TTL_MS = 10 * 60 * 1000;

let cache = null;
let expiresAt = 0;
let loadingPromise = null;

async function loadCache() {
  const raw = await morgenFetch("/v3/calendars/list", { points: 10 });
  const list = unwrapCalendars(raw);
  const byId = new Map();
  const byAccount = new Map();
  for (const c of list) {
    if (!c || !c.id) continue;
    const rights = c.myRights || {};
    const readOnly =
      rights.mayWriteAll === false && rights.mayReadItems === true;
    const entry = {
      id: c.id,
      name: c.name,
      accountId: c.accountId,
      integrationId: c.integrationId,
      color: c.color,
      readOnly,
    };
    byId.set(c.id, entry);
    if (entry.accountId) {
      if (!byAccount.has(entry.accountId)) byAccount.set(entry.accountId, []);
      byAccount.get(entry.accountId).push(entry);
    }
  }
  // Default writable calendar = first non-read-only entry in docs order.
  const defaultEntry =
    list.find((c) => c?.id && !(c.myRights?.mayWriteAll === false)) || list[0];
  const defaultId = defaultEntry?.id || null;
  cache = { list, byId, byAccount, defaultId };
  expiresAt = Date.now() + TTL_MS;
  return cache;
}

export async function getCalendarCache() {
  if (cache && expiresAt > Date.now()) return cache;
  if (loadingPromise) return loadingPromise;
  loadingPromise = loadCache().finally(() => {
    loadingPromise = null;
  });
  return loadingPromise;
}

export async function resolveCalendarMeta(calendarId) {
  const c = await getCalendarCache();
  const entry = c.byId.get(calendarId);
  if (!entry) {
    throw new Error(
      `calendar_id is not a known calendar on this account — run list_calendars to discover valid IDs`
    );
  }
  return entry;
}

export async function resolveDefaultCalendarMeta() {
  const c = await getCalendarCache();
  if (!c.defaultId) {
    throw new Error(
      "No calendars available on this account. Connect a calendar in Morgen first."
    );
  }
  return c.byId.get(c.defaultId);
}

export async function groupCalendarIdsByAccount(calendarIds) {
  const c = await getCalendarCache();
  const byAccount = new Map();
  for (const id of calendarIds) {
    const entry = c.byId.get(id);
    if (!entry) {
      throw new Error(
        `calendar_id ${id} is not a known calendar — run list_calendars to discover valid IDs`
      );
    }
    if (!byAccount.has(entry.accountId)) byAccount.set(entry.accountId, []);
    byAccount.get(entry.accountId).push(id);
  }
  return byAccount;
}

export async function getAllAccountsWithCalendars() {
  const c = await getCalendarCache();
  return c.byAccount;
}

export function _resetCalendarCache() {
  cache = null;
  expiresAt = 0;
  loadingPromise = null;
}

// Smart account routing: infer which connected account a new event should
// live on based on title, description, and participant emails. Routing is
// configured via MORGEN_ACCOUNT_ROUTES rather than hardcoded personal domains.
//
// MORGEN_ACCOUNT_ROUTES is JSON keyed by logical account name:
// {
//   "work": {
//     "domains": ["@example.com"],
//     "keywords": ["client sync"],
//     "calendar_patterns": ["Work", "bruno@example.com"],
//     "calendar_id": "optional-explicit-calendar-id"
//   }
// }
//
// Participant email domains are checked first, then free-text keywords in
// title + description. No match returns MORGEN_DEFAULT_ACCOUNT or "default".
const DEFAULT_ACCOUNT_NAME = "default";

function defaultAccountName() {
  return process.env.MORGEN_DEFAULT_ACCOUNT || DEFAULT_ACCOUNT_NAME;
}

function normalizeStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function parseAccountRoutes() {
  const raw = process.env.MORGEN_ACCOUNT_ROUTES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const routes = {};
    for (const [name, route] of Object.entries(parsed)) {
      if (!name || !route || typeof route !== "object" || Array.isArray(route)) continue;
      routes[name] = {
        domains: normalizeStringArray(route.domains).map((d) => d.toLowerCase()),
        keywords: normalizeStringArray(route.keywords).map((k) => k.toLowerCase()),
        calendarPatterns: [
          ...normalizeStringArray(route.calendar_patterns),
          ...normalizeStringArray(route.calendarPatterns),
          ...normalizeStringArray(route.calendars),
          ...normalizeStringArray(route.emails),
        ],
        calendarId: route.calendar_id || route.calendarId || null,
      };
    }
    return routes;
  } catch {
    return {};
  }
}

export function getConfiguredAccountNames() {
  const names = Object.keys(parseAccountRoutes());
  const fallback = defaultAccountName();
  return names.includes(fallback) ? names : [fallback, ...names];
}

export function inferAccountFromContext({ title = "", description = "", participants = [] }) {
  const routes = parseAccountRoutes();
  const text = `${title || ""} ${description || ""}`.toLowerCase();
  const emails = (participants || []).map((p) => String(p || "").toLowerCase());

  for (const [name, route] of Object.entries(routes)) {
    if (route.domains.some((domain) => emails.some((email) => email.endsWith(domain)))) {
      return name;
    }
  }
  for (const [name, route] of Object.entries(routes)) {
    if (route.keywords.some((keyword) => text.includes(keyword))) {
      return name;
    }
  }
  return defaultAccountName();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routePattern(route) {
  const parts = route?.calendarPatterns || [];
  if (!parts.length) return null;
  return new RegExp(parts.map(escapeRegExp).join("|"), "i");
}

// Map a logical account name to the calendar metadata entry Morgen uses.
// Falls back to the cache's default writable calendar if no configured route
// matches, preserving the upstream safety behavior without personal defaults.
export async function resolveCalendarByAccountName(name) {
  const c = await getCalendarCache();
  const routes = parseAccountRoutes();
  const route = routes[name];

  if (route?.calendarId) {
    const entry = c.byId.get(route.calendarId);
    if (entry && entry.readOnly !== true) return entry;
  }

  const pattern = routePattern(route);
  if (pattern) {
    for (const entry of c.list) {
      const calName = entry?.name || "";
      if (pattern.test(calName) && entry?.myRights?.mayWriteAll !== false) {
        return c.byId.get(entry.id);
      }
    }
  }

  if (c.defaultId) return c.byId.get(c.defaultId);
  throw new Error(
    `No calendar found for account name "${name}" and no default calendar is available`
  );
}

// Resolve the caller's own email address, used when keying RSVP patches into
// the Morgen participants map. Order of resolution:
//   1. MORGEN_SELF_EMAIL env var (explicit override, always wins)
//   2. The calendar meta's name if it looks like an email
//   3. Throw with a clear hint to set the env var
export function resolveSelfEmail(calendarMeta) {
  const envEmail = process.env.MORGEN_SELF_EMAIL;
  if (envEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envEmail)) {
    return envEmail;
  }
  const name = calendarMeta?.name || "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    return name;
  }
  throw new Error(
    `Could not determine your own email address for RSVP patching. Set the MORGEN_SELF_EMAIL environment variable in your MCP config.`
  );
}

// Test helper: preload the cache with fake entries so handlers can look up
// calendar metadata without hitting a real API. Entries should be
// { id, accountId, name?, readOnly?, integrationId?, color? } objects.
export function _seedCalendarCache(entries) {
  loadingPromise = null;
  const byId = new Map();
  const byAccount = new Map();
  for (const e of entries) {
    const entry = {
      id: e.id,
      name: e.name || e.id,
      accountId: e.accountId,
      integrationId: e.integrationId || "google",
      color: e.color || "#000000",
      readOnly: e.readOnly === true,
    };
    byId.set(entry.id, entry);
    if (!byAccount.has(entry.accountId)) byAccount.set(entry.accountId, []);
    byAccount.get(entry.accountId).push(entry);
  }
  const defaultEntry = entries.find((e) => !e.readOnly) || entries[0];
  cache = {
    list: entries,
    byId,
    byAccount,
    defaultId: defaultEntry ? defaultEntry.id : null,
  };
  expiresAt = Date.now() + 10 * 60 * 1000;
}
