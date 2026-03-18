import { beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const { runMigrations } = await import("../../src/migrations.js");
const { parseDirection } = await import("../../src/direction.js");
const { initializeAutonomy } = await import("../../src/adaptation/autonomy-init.js");
const { checkAdaptationPermission } = await import("../../src/adaptation/cards.js");
const { hireAgent } = await import("../../src/adaptation/hire.js");
const { getTemplate } = await import("../../src/templates/startup.js");
const { renderObservedEvents } = await import("../../src/context/observed-events.js");
const { EventsNamespace } = await import("../../src/sdk/events.js");
const { getActiveTrustOverrides } = await import("../../src/trust/tracker.js");

let db: ReturnType<typeof getMemoryDb>;
const PROJECT = "e2e-adapt";

beforeEach(() => {
  db = getMemoryDb();
  runMigrations(db);
});

describe("self-adaptation e2e flow", () => {
  it("full lifecycle: direction → template → autonomy → adaptation → hire", () => {
    // 1. Parse direction
    const direction = parseDirection(`
vision: "Ship ClawForce v1"
autonomy: medium
    `);
    expect(direction.vision).toBe("Ship ClawForce v1");
    expect(direction.autonomy).toBe("medium");

    // 2. Load template
    const template = getTemplate("startup");
    expect(template).not.toBeNull();
    expect(template!.agents.lead.extends).toBe("manager");
    expect(template!.agents["dev-1"].extends).toBe("employee");
    expect(template!.agents["agent-builder"].extends).toBe("employee");

    // 3. Initialize autonomy
    initializeAutonomy(PROJECT, direction.autonomy, db);
    const overrides = getActiveTrustOverrides(PROJECT, db);
    expect(overrides.length).toBeGreaterThan(0);

    // 4. Check adaptation permissions at medium trust
    // Low-risk cards should be auto-approved
    const skillPerm = checkAdaptationPermission("skill_creation", 0.55);
    expect(skillPerm.allowed).toBe(true);
    expect(skillPerm.requiresApproval).toBe(false);

    // Medium-risk cards should still require approval
    const hirePerm = checkAdaptationPermission("agent_hiring", 0.55);
    expect(hirePerm.allowed).toBe(true);
    expect(hirePerm.requiresApproval).toBe(true);

    // 5. Manager hires a budget specialist
    const hireResult = hireAgent(PROJECT, {
      agentId: "budget-ops",
      extends: "employee",
      title: "Budget Operations Specialist",
      reports_to: "lead",
      observe: ["budget.exceeded", "budget.warning"],
    });
    expect(hireResult.success).toBe(true);

    // 6. Budget events flow to the observer's briefing
    const events = new EventsNamespace(PROJECT);
    events.emit("budget.exceeded", { agent: "dev-1", overage: 200 }, { db });

    const briefing = renderObservedEvents(PROJECT, ["budget.*"], 0, db);
    expect(briefing).toContain("budget.exceeded");
    expect(briefing).toContain("dev-1");
  });
});
