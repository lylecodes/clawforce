import { describe, expect, it } from "vitest";

describe("wake bounds enforcement", () => {
  it("clamps cron expression to fastest bound", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    const result = clampCronToWakeBounds("*/5 * * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("*/15 * * * *");
  });

  it("clamps cron expression to slowest bound", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    const result = clampCronToWakeBounds("*/180 * * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("*/120 * * * *");
  });

  it("returns original when within bounds", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    const result = clampCronToWakeBounds("*/30 * * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("*/30 * * * *");
  });

  it("returns original when bounds not provided", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    const result = clampCronToWakeBounds("*/5 * * * *", undefined);
    expect(result).toBe("*/5 * * * *");
  });

  it("passes through complex cron expressions unclamped", async () => {
    const { clampCronToWakeBounds } = await import("../../src/scheduling/wake-bounds.js");

    // Non-*/N pattern — can't be compared as interval
    const result = clampCronToWakeBounds("0 */2 * * *", ["*/15 * * * *", "*/120 * * * *"]);
    expect(result).toBe("0 */2 * * *");
  });
});
