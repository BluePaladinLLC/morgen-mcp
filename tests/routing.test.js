// Unit tests for environment-driven smart account routing and RSVP email resolution.
//
// These don't hit the network — they exercise the pure inference function
// from calendar-cache.js and calendar metadata resolution from the seeded cache.
import { describe, it, expect, beforeEach } from "vitest";
import {
  inferAccountFromContext,
  _resetCalendarCache,
  _seedCalendarCache,
  resolveCalendarByAccountName,
  resolveSelfEmail,
} from "../src/calendar-cache.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.MORGEN_DEFAULT_ACCOUNT = "primary";
  process.env.MORGEN_ACCOUNT_ROUTES = JSON.stringify({
    primary: {
      domains: ["@example.com"],
      keywords: ["personal"],
      calendar_patterns: ["primary@example.com"],
    },
    client: {
      domains: ["@client.test"],
      keywords: ["client sync", "launch review"],
      calendar_patterns: ["client@example.com"],
    },
    team: {
      domains: ["@team.test"],
      keywords: ["team standup"],
      calendar_patterns: ["team@example.com"],
    },
  });
  delete process.env.MORGEN_SELF_EMAIL;

  _resetCalendarCache();
  _seedCalendarCache([
    {
      id: "cal-primary",
      accountId: "acct-primary",
      name: "primary@example.com",
      integrationId: "google",
    },
    {
      id: "cal-client",
      accountId: "acct-client",
      name: "client@example.com",
      integrationId: "google",
    },
    {
      id: "cal-team",
      accountId: "acct-team",
      name: "team@example.com",
      integrationId: "google",
    },
  ]);
});

describe("inferAccountFromContext", () => {
  it("defaults to MORGEN_DEFAULT_ACCOUNT with no signals", () => {
    expect(inferAccountFromContext({ title: "Dentist" })).toBe("primary");
  });

  it("routes to a configured account on participant email domain", () => {
    expect(
      inferAccountFromContext({
        title: "Sync",
        participants: ["someone@client.test"],
      })
    ).toBe("client");
  });

  it("routes to a configured account on keyword in title", () => {
    expect(inferAccountFromContext({ title: "Launch review prep" })).toBe("client");
  });

  it("routes to a configured account on keyword in description", () => {
    expect(
      inferAccountFromContext({
        title: "Sync",
        description: "Agenda for team standup",
      })
    ).toBe("team");
  });

  it("earlier configured route wins when keyword signals overlap", () => {
    process.env.MORGEN_ACCOUNT_ROUTES = JSON.stringify({
      alpha: { keywords: ["shared"] },
      beta: { keywords: ["shared"] },
    });
    expect(inferAccountFromContext({ title: "shared planning" })).toBe("alpha");
  });

  it("participant email beats title-only signals", () => {
    expect(
      inferAccountFromContext({
        title: "Team standup",
        participants: ["person@client.test"],
      })
    ).toBe("client");
  });
});

describe("resolveCalendarByAccountName", () => {
  it("resolves configured primary route by calendar pattern", async () => {
    const meta = await resolveCalendarByAccountName("primary");
    expect(meta.id).toBe("cal-primary");
    expect(meta.accountId).toBe("acct-primary");
  });

  it("resolves configured client route by calendar pattern", async () => {
    const meta = await resolveCalendarByAccountName("client");
    expect(meta.id).toBe("cal-client");
  });

  it("resolves configured team route by calendar pattern", async () => {
    const meta = await resolveCalendarByAccountName("team");
    expect(meta.id).toBe("cal-team");
  });

  it("falls back to default when account name not found", async () => {
    const meta = await resolveCalendarByAccountName("nonexistent");
    expect(meta.id).toBe("cal-primary");
  });

  it("can resolve an explicit configured calendar_id", async () => {
    process.env.MORGEN_ACCOUNT_ROUTES = JSON.stringify({
      direct: { calendar_id: "cal-team" },
    });
    const meta = await resolveCalendarByAccountName("direct");
    expect(meta.id).toBe("cal-team");
  });
});

describe("resolveSelfEmail", () => {
  it("prefers MORGEN_SELF_EMAIL env var when valid", () => {
    process.env.MORGEN_SELF_EMAIL = "override@example.com";
    const email = resolveSelfEmail({ name: "primary@example.com" });
    expect(email).toBe("override@example.com");
  });

  it("derives from calendar name if env var unset and name looks like an email", () => {
    const email = resolveSelfEmail({ name: "primary@example.com" });
    expect(email).toBe("primary@example.com");
  });

  it("ignores invalid env var value and falls back to calendar name", () => {
    process.env.MORGEN_SELF_EMAIL = "not-an-email";
    const email = resolveSelfEmail({ name: "client@example.com" });
    expect(email).toBe("client@example.com");
  });

  it("throws with a clear hint when neither source is available", () => {
    expect(() => resolveSelfEmail({ name: "Work" })).toThrow(
      /MORGEN_SELF_EMAIL/
    );
  });
});
