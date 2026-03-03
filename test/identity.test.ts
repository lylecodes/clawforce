import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  getProjectsDir: () => "/tmp/clawforce-identity-test",
}));

// Mock fs to avoid writing platform secret to disk in tests
const mockFs: Record<string, string> = {};
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn((p: string) => {
      if (mockFs[p]) return mockFs[p];
      throw new Error("ENOENT");
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      mockFs[p] = typeof data === "string" ? data : "";
    }),
    mkdirSync: vi.fn(),
  },
}));

const {
  getAgentIdentity,
  signAction,
  verifyAction,
  resetIdentitiesForTest,
} = await import("../src/identity.js");

describe("clawforce/identity", () => {
  beforeEach(() => {
    resetIdentitiesForTest();
    // Clear mock fs
    for (const key of Object.keys(mockFs)) {
      delete mockFs[key];
    }
  });

  it("generates consistent identity for an agent", () => {
    const id1 = getAgentIdentity("agent:alice");
    const id2 = getAgentIdentity("agent:alice");
    expect(id1.identityToken).toBe(id2.identityToken);
    expect(id1.hmacKey).toBe(id2.hmacKey);
  });

  it("generates different identities for different agents", () => {
    const id1 = getAgentIdentity("agent:alice");
    const id2 = getAgentIdentity("agent:bob");
    expect(id1.identityToken).not.toBe(id2.identityToken);
    expect(id1.hmacKey).not.toBe(id2.hmacKey);
  });

  it("signs and verifies actions", () => {
    const data = "transition:task123:OPEN:ASSIGNED:agent:alice:1234567890";
    const sig = signAction("agent:alice", data);
    expect(sig).toBeTruthy();
    expect(typeof sig).toBe("string");

    expect(verifyAction("agent:alice", data, sig)).toBe(true);
    expect(verifyAction("agent:alice", data + "tampered", sig)).toBe(false);
    expect(verifyAction("agent:bob", data, sig)).toBe(false);
  });
});
