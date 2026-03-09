import { describe, it, expect } from "vitest";
import { recordCostFromLlmOutput } from "../../src/cost.js";
import { registerModelPricingFromConfig, clearPricingCache } from "../../src/pricing.js";
import { getDb } from "../../src/db.js";

describe("cost auto-capture", () => {
  const projectId = "test-auto-capture";

  it("recordCostFromLlmOutput creates a cost record from hook event data", () => {
    clearPricingCache();
    registerModelPricingFromConfig("claude-sonnet-4-6", {
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    });

    const db = getDb(projectId);
    db.prepare("DELETE FROM cost_records WHERE project_id = ?").run(projectId);

    const record = recordCostFromLlmOutput({
      projectId,
      agentId: "test-agent",
      sessionKey: "sess-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 5000, output: 1000, cacheRead: 2000, cacheWrite: 0 },
    });

    expect(record.inputTokens).toBe(5000);
    expect(record.outputTokens).toBe(1000);
    expect(record.cacheReadTokens).toBe(2000);
    expect(record.provider).toBe("anthropic");
    expect(record.source).toBe("llm_output");
    expect(record.costCents).toBeGreaterThan(0);
  });
});
