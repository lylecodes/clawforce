import { describe, expect, it } from "vitest";

const { checkAdaptationPermission, ADAPTATION_CARDS } = await import("../../src/adaptation/cards.js");

describe("ADAPTATION_CARDS", () => {
  it("defines risk levels for all card types", () => {
    expect(ADAPTATION_CARDS.skill_creation.risk).toBe("low");
    expect(ADAPTATION_CARDS.budget_reallocation.risk).toBe("low");
    expect(ADAPTATION_CARDS.process_change.risk).toBe("medium");
    expect(ADAPTATION_CARDS.agent_hiring.risk).toBe("medium");
    expect(ADAPTATION_CARDS.agent_splitting.risk).toBe("medium");
    expect(ADAPTATION_CARDS.infra_provisioning.risk).toBe("high");
    expect(ADAPTATION_CARDS.escalation.risk).toBe("none");
  });
});

describe("checkAdaptationPermission", () => {
  it("allows escalation at any trust level", () => {
    const result = checkAdaptationPermission("escalation", 0.1);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for all cards at low trust", () => {
    const result = checkAdaptationPermission("skill_creation", 0.2);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("auto-approves low-risk cards at medium trust", () => {
    const result = checkAdaptationPermission("skill_creation", 0.5);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for medium-risk cards at medium trust", () => {
    const result = checkAdaptationPermission("agent_hiring", 0.5);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("auto-approves medium-risk cards at high trust", () => {
    const result = checkAdaptationPermission("agent_hiring", 0.85);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for high-risk cards at high trust", () => {
    const result = checkAdaptationPermission("infra_provisioning", 0.85);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("rejects unknown card types", () => {
    const result = checkAdaptationPermission("unknown_card", 0.5);
    expect(result.allowed).toBe(false);
  });
});
