import { afterEach, describe, expect, it } from "vitest";
import {
  setOpenClawConfig,
  getAgentModel,
  getAgentTools,
  getModelPricing,
  clearOpenClawConfigCache,
} from "../../src/config/openclaw-reader.js";

describe("openclaw-reader", () => {
  afterEach(() => {
    clearOpenClawConfigCache();
  });

  it("returns agent model from config", () => {
    setOpenClawConfig({
      agents: {
        list: [{ id: "lead", model: { primary: "claude-opus-4-6" } }],
        defaults: { model: "claude-sonnet-4-6" },
      },
    });
    expect(getAgentModel("lead")).toBe("claude-opus-4-6");
  });

  it("falls back to default model", () => {
    setOpenClawConfig({
      agents: {
        list: [{ id: "worker" }],
        defaults: { model: "claude-sonnet-4-6" },
      },
    });
    expect(getAgentModel("worker")).toBe("claude-sonnet-4-6");
  });

  it("flattens default model objects to their primary model", () => {
    setOpenClawConfig({
      agents: {
        list: [{ id: "worker" }],
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
            fallbacks: ["openai-codex/gpt-4.1"],
          },
        },
      },
    });
    expect(getAgentModel("worker")).toBe("openai-codex/gpt-5.4");
  });

  it("returns null for unknown agent", () => {
    setOpenClawConfig({ agents: { list: [], defaults: {} } });
    expect(getAgentModel("nobody")).toBeNull();
  });

  it("returns model pricing", () => {
    setOpenClawConfig({
      models: {
        providers: [
          {
            id: "anthropic",
            models: [
              {
                id: "claude-opus-4-6",
                cost: { input: 1500, output: 7500 },
              },
            ],
          },
        ],
      },
    });
    const pricing = getModelPricing("claude-opus-4-6");
    expect(pricing).toEqual({ inputPer1M: 1500, outputPer1M: 7500 });
  });

  it("returns null for unknown model pricing", () => {
    setOpenClawConfig({ models: { providers: [] } });
    expect(getModelPricing("unknown")).toBeNull();
  });
});
