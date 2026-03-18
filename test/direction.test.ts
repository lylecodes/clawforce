import { describe, expect, it } from "vitest";

const { parseDirection, validateDirection } = await import("../src/direction.js");

describe("parseDirection", () => {
  it("parses minimal direction (vision only)", () => {
    const dir = parseDirection("vision: Build a rental compliance SaaS");
    expect(dir.vision).toBe("Build a rental compliance SaaS");
    expect(dir.constraints).toBeUndefined();
    expect(dir.phases).toBeUndefined();
    expect(dir.autonomy).toBe("low");
  });

  it("parses full direction with all fields", () => {
    const yaml = `
vision: "Build a rental compliance SaaS"
constraints:
  budget_daily_cents: 5000
  tech_stack: [Next.js, Postgres]
  timeline: "MVP in 2 weeks"
phases:
  - name: Foundation
    goals: ["Set up repo", "Auth system"]
  - name: Core
    goals: ["Property tracking"]
autonomy: high
`;
    const dir = parseDirection(yaml);
    expect(dir.vision).toBe("Build a rental compliance SaaS");
    expect(dir.constraints?.budget_daily_cents).toBe(5000);
    expect(dir.constraints?.tech_stack).toEqual(["Next.js", "Postgres"]);
    expect(dir.phases).toHaveLength(2);
    expect(dir.phases![0].name).toBe("Foundation");
    expect(dir.autonomy).toBe("high");
  });

  it("parses plain text as vision-only", () => {
    const dir = parseDirection("Build me an app that tracks rental violations");
    expect(dir.vision).toBe("Build me an app that tracks rental violations");
  });
});

describe("validateDirection", () => {
  it("rejects empty vision", () => {
    const result = validateDirection({ vision: "" });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("vision");
  });

  it("rejects invalid autonomy value", () => {
    const result = validateDirection({ vision: "test", autonomy: "extreme" as any });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("autonomy");
  });

  it("accepts valid minimal direction", () => {
    const result = validateDirection({ vision: "Build something" });
    expect(result.valid).toBe(true);
  });
});
