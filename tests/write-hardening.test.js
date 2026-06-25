import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventHandlers } from "../src/tools-events.js";
import { _resetRateLimiter } from "../src/client.js";
import { _resetCalendarCache, _seedCalendarCache } from "../src/calendar-cache.js";

const ORIGINAL_ENV = { ...process.env };

function response({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.MORGEN_API_KEY = "test-key-placeholder";
  process.env.MORGEN_DEFAULT_ACCOUNT = "bruno";
  process.env.MORGEN_ACCOUNT_ROUTES = JSON.stringify({
    bruno: { calendar_id: "cal-bruno" },
  });
  _resetRateLimiter();
  _resetCalendarCache();
  _seedCalendarCache([
    { id: "cal-bruno", accountId: "acct-bruno", name: "Bruno", readOnly: false },
  ]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("write hardening", () => {
  it("returns an existing matching event instead of creating a duplicate", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v3/events/list")) {
        return response({
          body: {
            data: {
              events: [
                {
                  id: "evt-existing",
                  calendarId: "cal-bruno",
                  title: "Synapse MCP diagnostic — delete me",
                  start: "2026-06-25T15:00:00",
                  end: "2026-06-25T15:05:00",
                },
              ],
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await eventHandlers.create_event({
      calendar_id: "cal-bruno",
      title: "Synapse MCP diagnostic — delete me",
      start: "2026-06-25T15:00:00-04:00",
      end: "2026-06-25T15:05:00-04:00",
      timezone: "America/New_York",
    });

    expect(result.success).toBe(true);
    expect(result.event.id).toBe("evt-existing");
    expect(result.duplicateGuard).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v3/events/list");
  });

  it("checks for a matching event after an uncertain create failure", async () => {
    const fetchMock = vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes("/v3/events/list")) {
        const callCount = fetchMock.mock.calls.filter(([u]) => String(u).includes("/v3/events/list")).length;
        return response({
          body: {
            data: {
              events: callCount === 1 ? [] : [
                {
                  id: "evt-created-despite-error",
                  calendarId: "cal-bruno",
                  title: "Recovered event",
                  start: "2026-06-25T15:00:00",
                  end: "2026-06-25T15:05:00",
                },
              ],
            },
          },
        });
      }
      if (urlString.includes("/v3/events/create")) {
        throw new Error("socket hang up after upstream write");
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await eventHandlers.create_event({
      calendar_id: "cal-bruno",
      title: "Recovered event",
      start: "2026-06-25T15:00:00-04:00",
      end: "2026-06-25T15:05:00-04:00",
      timezone: "America/New_York",
    });

    expect(result.success).toBe(true);
    expect(result.event.id).toBe("evt-created-despite-error");
    expect(result.recoveredAfterCreateError).toBe(true);
  });
});
