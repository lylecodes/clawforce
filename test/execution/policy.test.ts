import { describe, expect, it } from "vitest";

import {
  getDefaultMutationEffect,
  resolveCommandExecutionEffect,
  resolveToolExecutionEffect,
} from "../../src/execution/policy.js";

describe("execution policy resolution", () => {
  it("defaults dry-run domains to simulated mutations", () => {
    expect(getDefaultMutationEffect({ mode: "dry_run" })).toBe("simulate");
    expect(getDefaultMutationEffect({ mode: "live" })).toBe("allow");
  });

  it("resolves tool action policies before fallback defaults", () => {
    const config = {
      mode: "dry_run" as const,
      defaultMutationPolicy: "block" as const,
      policies: {
        tools: {
          clawforce_entity: {
            default: "simulate" as const,
            actions: {
              create: "allow" as const,
              transition: "require_approval" as const,
            },
          },
        },
      },
    };

    expect(resolveToolExecutionEffect(config, "clawforce_entity", "create")).toBe("allow");
    expect(resolveToolExecutionEffect(config, "clawforce_entity", "transition")).toBe("require_approval");
    expect(resolveToolExecutionEffect(config, "clawforce_entity", "archive")).toBe("simulate");
    expect(resolveToolExecutionEffect(config, "shell", "exec")).toBe("block");
  });

  it("resolves wildcard command policies", () => {
    const config = {
      mode: "dry_run" as const,
      policies: {
        commands: [
          { match: "cd backend && npm run data:validate*", effect: "allow" as const },
          { match: "cd backend && npm run data:generate*", effect: "simulate" as const },
        ],
      },
    };

    expect(resolveCommandExecutionEffect(config, "cd backend && npm run data:validate -- --json")).toBe("allow");
    expect(resolveCommandExecutionEffect(config, "cd backend && npm run data:generate -- --jurisdiction=la")).toBe("simulate");
    expect(resolveCommandExecutionEffect(config, "cd backend && npm run db:migrate")).toBe("simulate");
  });
});
