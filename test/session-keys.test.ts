import { describe, expect, it } from "vitest";
import { extractAgentIdFromReference, parseAgentSessionKey } from "../src/session-keys.js";

describe("session key parsing", () => {
  it("parses colon-containing agent IDs from session keys", () => {
    expect(parseAgentSessionKey("agent:agent:verifier:cron:session-1")).toEqual({
      agentId: "agent:verifier",
      sessionType: "cron",
      suffix: ["session-1"],
    });
  });

  it("parses meeting session keys with extra suffix segments", () => {
    expect(parseAgentSessionKey("agent:lead:meeting:channel-1:4")).toEqual({
      agentId: "lead",
      sessionType: "meeting",
      suffix: ["channel-1", "4"],
    });
  });

  it("extracts plain agent references without truncating colon-bearing IDs", () => {
    expect(extractAgentIdFromReference("agent:agent:verifier")).toBe("agent:verifier");
    expect(extractAgentIdFromReference("agent:agent:verifier:cron:session-1")).toBe("agent:verifier");
    expect(extractAgentIdFromReference("cf-lead")).toBe("cf-lead");
  });
});
