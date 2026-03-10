import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const {
  setPreference,
  getPreference,
  listPreferences,
  deletePreference,
  renderPreferences,
} = await import("../../src/trust/preferences.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "test-prefs";
const AGENT = "assistant";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("setPreference", () => {
  it("creates a new preference", () => {
    const pref = setPreference({
      projectId: PROJECT,
      agentId: AGENT,
      category: "scheduling",
      key: "earliest_meeting",
      value: "10:00 AM",
    }, db);

    expect(pref.id).toBeDefined();
    expect(pref.category).toBe("scheduling");
    expect(pref.key).toBe("earliest_meeting");
    expect(pref.value).toBe("10:00 AM");
    expect(pref.source).toBe("explicit");
    expect(pref.confidence).toBe(1.0);
  });

  it("upserts existing preference", () => {
    setPreference({
      projectId: PROJECT,
      agentId: AGENT,
      category: "scheduling",
      key: "earliest_meeting",
      value: "10:00 AM",
    }, db);

    const updated = setPreference({
      projectId: PROJECT,
      agentId: AGENT,
      category: "scheduling",
      key: "earliest_meeting",
      value: "9:00 AM",
    }, db);

    expect(updated.value).toBe("9:00 AM");

    // Should only have one preference
    const all = listPreferences(PROJECT, AGENT, "scheduling", db);
    expect(all).toHaveLength(1);
  });

  it("sets learned source with confidence", () => {
    const pref = setPreference({
      projectId: PROJECT,
      agentId: AGENT,
      category: "communication",
      key: "email_tone",
      value: "concise",
      source: "learned",
      confidence: 0.8,
    }, db);

    expect(pref.source).toBe("learned");
    expect(pref.confidence).toBe(0.8);
  });
});

describe("getPreference", () => {
  it("returns null for non-existent preference", () => {
    const pref = getPreference(PROJECT, AGENT, "scheduling", "nonexistent", db);
    expect(pref).toBeNull();
  });

  it("retrieves an existing preference", () => {
    setPreference({
      projectId: PROJECT,
      agentId: AGENT,
      category: "scheduling",
      key: "timezone",
      value: "America/New_York",
    }, db);

    const pref = getPreference(PROJECT, AGENT, "scheduling", "timezone", db);
    expect(pref).not.toBeNull();
    expect(pref!.value).toBe("America/New_York");
  });
});

describe("listPreferences", () => {
  it("returns empty array when none exist", () => {
    const prefs = listPreferences(PROJECT, AGENT, undefined, db);
    expect(prefs).toHaveLength(0);
  });

  it("lists all preferences for an agent", () => {
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "scheduling", key: "tz", value: "UTC" }, db);
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "communication", key: "tone", value: "formal" }, db);

    const all = listPreferences(PROJECT, AGENT, undefined, db);
    expect(all).toHaveLength(2);
  });

  it("filters by category", () => {
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "scheduling", key: "tz", value: "UTC" }, db);
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "communication", key: "tone", value: "formal" }, db);

    const scheduling = listPreferences(PROJECT, AGENT, "scheduling", db);
    expect(scheduling).toHaveLength(1);
    expect(scheduling[0]!.key).toBe("tz");
  });
});

describe("deletePreference", () => {
  it("deletes an existing preference", () => {
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "scheduling", key: "tz", value: "UTC" }, db);

    const deleted = deletePreference(PROJECT, AGENT, "scheduling", "tz", db);
    expect(deleted).toBe(true);

    const pref = getPreference(PROJECT, AGENT, "scheduling", "tz", db);
    expect(pref).toBeNull();
  });

  it("returns false for non-existent preference", () => {
    const deleted = deletePreference(PROJECT, AGENT, "scheduling", "nonexistent", db);
    expect(deleted).toBe(false);
  });
});

describe("renderPreferences", () => {
  it("returns null when no preferences", () => {
    const md = renderPreferences(PROJECT, AGENT, db);
    expect(md).toBeNull();
  });

  it("renders markdown grouped by category", () => {
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "scheduling", key: "earliest_meeting", value: "10:00 AM" }, db);
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "scheduling", key: "timezone", value: "America/New_York" }, db);
    setPreference({ projectId: PROJECT, agentId: AGENT, category: "communication", key: "email_tone", value: "concise" }, db);

    const md = renderPreferences(PROJECT, AGENT, db);
    expect(md).not.toBeNull();
    expect(md).toContain("## User Preferences");
    expect(md).toContain("### scheduling");
    expect(md).toContain("### communication");
    expect(md).toContain("10:00 AM");
  });

  it("shows source tag for non-explicit preferences", () => {
    setPreference({
      projectId: PROJECT,
      agentId: AGENT,
      category: "communication",
      key: "preferred_length",
      value: "short",
      source: "learned",
      confidence: 0.75,
    }, db);

    const md = renderPreferences(PROJECT, AGENT, db);
    expect(md).toContain("learned");
    expect(md).toContain("75%");
  });
});
