import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb, validateProjectId, getDb } = await import("../src/db.js");

let db: ReturnType<typeof getMemoryDb>;

beforeEach(() => {
  db = getMemoryDb();
});

afterEach(() => {
  try { db.close(); } catch {}
});

describe("validateProjectId", () => {
  describe("rejects invalid IDs", () => {
    it("rejects empty string", () => {
      expect(() => validateProjectId("")).toThrow("Invalid project ID");
    });

    it("rejects path traversal like '../evil'", () => {
      expect(() => validateProjectId("../evil")).toThrow("Invalid project ID");
    });

    it("rejects absolute paths like '/etc/passwd'", () => {
      expect(() => validateProjectId("/etc/passwd")).toThrow("Invalid project ID");
    });

    it("rejects IDs with spaces", () => {
      expect(() => validateProjectId("my project")).toThrow("Invalid project ID");
    });

    it("rejects IDs starting with dot", () => {
      expect(() => validateProjectId(".hidden")).toThrow("Invalid project ID");
    });

    it("rejects IDs starting with dash", () => {
      expect(() => validateProjectId("-flag")).toThrow("Invalid project ID");
    });

    it("rejects IDs longer than 64 chars", () => {
      const longId = "a".repeat(65);
      expect(() => validateProjectId(longId)).toThrow("Invalid project ID");
    });
  });

  describe("accepts valid IDs", () => {
    it("accepts simple ID like 'my-project'", () => {
      expect(() => validateProjectId("my-project")).not.toThrow();
    });

    it("accepts ID with dots like 'my.project'", () => {
      expect(() => validateProjectId("my.project")).not.toThrow();
    });

    it("accepts ID with underscores like 'my_project'", () => {
      expect(() => validateProjectId("my_project")).not.toThrow();
    });

    it("accepts single char like 'a'", () => {
      expect(() => validateProjectId("a")).not.toThrow();
    });

    it("accepts exactly 64-char ID", () => {
      const maxId = "a".repeat(64);
      expect(() => validateProjectId(maxId)).not.toThrow();
    });
  });
});

describe("getDb rejects invalid project IDs", () => {
  it("throws on path traversal attempt", () => {
    expect(() => getDb("../evil")).toThrow("Invalid project ID");
  });

  it("throws on empty string", () => {
    expect(() => getDb("")).toThrow("Invalid project ID");
  });

  it("throws on absolute path", () => {
    expect(() => getDb("/etc/passwd")).toThrow("Invalid project ID");
  });
});
