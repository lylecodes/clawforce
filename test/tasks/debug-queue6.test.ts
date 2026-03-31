import { it, expect, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({ emitDiagnosticEvent: vi.fn(), safeLog: vi.fn() }));
vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "sig"),
  getAgentIdentity: vi.fn(() => ({ agentId: "test", hmacKey: "x", identityToken: "tok", issuedAt: Date.now() })),
}));

// Read source to see what version of ops.ts vitest is using
it("verify source content", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync("/Users/lylejens/workplace/clawforce/src/tasks/ops.ts", "utf8");
  const hasIsNonDispatchable = src.includes("isNonDispatchable");
  const hasCancelQueueItem = src.includes("cancelQueueItem");
  console.log("Has isNonDispatchable:", hasIsNonDispatchable);
  console.log("Has cancelQueueItem:", hasCancelQueueItem);
  
  // Show the relevant section
  const idx = src.indexOf("isNonDispatchable");
  if (idx > 0) {
    console.log("Context:", src.slice(idx - 100, idx + 200));
  }
});
