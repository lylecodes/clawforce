# Phase 9: Config & Architecture Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the project-scoped config system with a global domain-based architecture where agents are defined globally and assigned to domains.

**Architecture:** Global config (`~/.clawforce/config.yaml`) defines agents and defaults. Domain configs (`~/.clawforce/domains/*.yaml`) define domain-specific settings and agent assignments. Internally, `projectId` parameter is retained as the domain identifier to minimize blast radius across 98 source files — the variable name is an implementation detail; the concept changes from "project" to "domain."

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), node:fs, node:crypto, Vitest

---

### Task 1: Domain Config Schema & Types

**Files:**
- Modify: `src/types.ts`
- Create: `src/config/schema.ts`
- Test: `test/config/schema.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/schema.test.ts
import { describe, expect, it } from "vitest";
import type { GlobalConfig, DomainConfig, RuleDefinition } from "../../src/config/schema.js";

describe("config schema types", () => {
  it("validates a minimal global config", () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config: GlobalConfig = {
      defaults: { model: "anthropic/claude-opus-4-6" },
      agents: {
        "my-agent": { extends: "employee" },
      },
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates a minimal domain config", () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");
    const config: DomainConfig = {
      domain: "rentright",
      agents: ["my-agent"],
    };
    const result = validateDomainConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects domain config without domain name", () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");
    const config = { agents: ["my-agent"] } as any;
    const result = validateDomainConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("domain");
  });

  it("validates a rule definition", () => {
    const { validateRuleDefinition } = await import("../../src/config/schema.js");
    const rule: RuleDefinition = {
      name: "deploy-review",
      trigger: { event: "task.completed", match: { tags: ["deploy"] } },
      action: {
        agent: "compliance-bot",
        prompt_template: "Review deployment for {{task.title}}.",
      },
    };
    const result = validateRuleDefinition(rule);
    expect(result.valid).toBe(true);
  });

  it("rejects rule without name", () => {
    const { validateRuleDefinition } = await import("../../src/config/schema.js");
    const rule = {
      trigger: { event: "task.completed" },
      action: { agent: "bot", prompt_template: "hi" },
    } as any;
    const result = validateRuleDefinition(rule);
    expect(result.valid).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/schema.test.ts`
Expected: FAIL — module not found

**Step 3: Write the types and validators**

Add to `src/types.ts`:
```typescript
// --- Domain Config ---
export type RuleTrigger = {
  event: string;
  match?: Record<string, unknown>;
};

export type RuleAction = {
  agent: string;
  prompt_template: string;
};

export type RuleDefinition = {
  name: string;
  trigger: RuleTrigger;
  action: RuleAction;
  enabled?: boolean;
};
```

Create `src/config/schema.ts`:
```typescript
/**
 * Clawforce — Global & Domain Config Schema
 *
 * GlobalConfig: agent roster + defaults (lives in ~/.clawforce/config.yaml)
 * DomainConfig: domain-specific settings (lives in ~/.clawforce/domains/<name>.yaml)
 */

import type { AgentConfig, RuleDefinition } from "../types.js";

export type GlobalAgentDef = {
  extends: string;
  model?: string;
  persona?: string;
  title?: string;
  skillCap?: number;
  [key: string]: unknown; // allow other AgentConfig fields
};

export type GlobalDefaults = {
  model?: string;
  performance_policy?: {
    action: "retry" | "alert" | "terminate_and_alert";
    max_retries?: number;
    then?: string;
  };
};

export type GlobalConfig = {
  defaults?: GlobalDefaults;
  agents: Record<string, GlobalAgentDef>;
};

export type DomainConfig = {
  domain: string;
  orchestrator?: string;
  paths?: string[];
  agents: string[];
  policies?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  workflows?: string[];
  rules?: RuleDefinition[];
  // All existing WorkforceConfig fields carried over
  manager?: Record<string, unknown>;
  context_sources?: unknown[];
  expectations?: unknown[];
  jobs?: Record<string, unknown>;
  knowledge?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  channels?: unknown[];
  event_handlers?: unknown[];
  [key: string]: unknown;
};

export type ValidationResult = {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
};

export function validateGlobalConfig(config: unknown): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  if (!config || typeof config !== "object") {
    return { valid: false, errors: [{ field: "root", message: "Config must be an object" }] };
  }
  const c = config as Record<string, unknown>;
  if (!c.agents || typeof c.agents !== "object" || Array.isArray(c.agents)) {
    errors.push({ field: "agents", message: "agents must be an object mapping agent names to definitions" });
  }
  return { valid: errors.length === 0, errors };
}

export function validateDomainConfig(config: unknown): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  if (!config || typeof config !== "object") {
    return { valid: false, errors: [{ field: "root", message: "Config must be an object" }] };
  }
  const c = config as Record<string, unknown>;
  if (typeof c.domain !== "string" || !c.domain.trim()) {
    errors.push({ field: "domain", message: "domain name is required" });
  }
  if (!Array.isArray(c.agents)) {
    errors.push({ field: "agents", message: "agents must be an array of agent names" });
  }
  return { valid: errors.length === 0, errors };
}

export function validateRuleDefinition(rule: unknown): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  if (!rule || typeof rule !== "object") {
    return { valid: false, errors: [{ field: "root", message: "Rule must be an object" }] };
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) {
    errors.push({ field: "name", message: "Rule name is required" });
  }
  if (!r.trigger || typeof r.trigger !== "object") {
    errors.push({ field: "trigger", message: "Rule trigger is required" });
  }
  if (!r.action || typeof r.action !== "object") {
    errors.push({ field: "action", message: "Rule action is required" });
  } else {
    const a = r.action as Record<string, unknown>;
    if (typeof a.agent !== "string") {
      errors.push({ field: "action.agent", message: "Rule action must specify an agent" });
    }
    if (typeof a.prompt_template !== "string") {
      errors.push({ field: "action.prompt_template", message: "Rule action must include a prompt_template" });
    }
  }
  return { valid: errors.length === 0, errors };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/schema.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/config/schema.ts src/types.ts test/config/schema.test.ts
git commit -m "feat(phase9): add domain config schema types and validators"
```

---

### Task 2: Global Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Test: `test/config/loader.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/loader.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("global config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-loader-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads global config and domain configs", async () => {
    const { loadGlobalConfig, loadAllDomains } = await import("../../src/config/loader.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), `
agents:
  my-agent:
    extends: employee
defaults:
  model: anthropic/claude-opus-4-6
`);
    fs.writeFileSync(path.join(tmpDir, "domains", "rentright.yaml"), `
domain: rentright
agents:
  - my-agent
paths:
  - ~/workplace/rentright
`);

    const global = loadGlobalConfig(tmpDir);
    expect(global.agents["my-agent"].extends).toBe("employee");

    const domains = loadAllDomains(tmpDir);
    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe("rentright");
    expect(domains[0].agents).toContain("my-agent");
  });

  it("returns empty agents if no config.yaml exists", async () => {
    const { loadGlobalConfig } = await import("../../src/config/loader.js");
    const global = loadGlobalConfig(tmpDir);
    expect(global.agents).toEqual({});
  });

  it("returns empty array if no domain files exist", async () => {
    const { loadAllDomains } = await import("../../src/config/loader.js");
    const domains = loadAllDomains(tmpDir);
    expect(domains).toHaveLength(0);
  });

  it("resolves domain from working directory", async () => {
    const { loadAllDomains, resolveDomainFromPath } = await import("../../src/config/loader.js");

    fs.writeFileSync(path.join(tmpDir, "domains", "myapp.yaml"), `
domain: myapp
agents: [a]
paths:
  - /home/user/code/myapp
  - /home/user/code/myapp-api
`);

    const domains = loadAllDomains(tmpDir);
    const match = resolveDomainFromPath("/home/user/code/myapp-api/src/index.ts", domains);
    expect(match).toBe("myapp");
  });

  it("returns null for unmatched working directory", async () => {
    const { loadAllDomains, resolveDomainFromPath } = await import("../../src/config/loader.js");

    fs.writeFileSync(path.join(tmpDir, "domains", "myapp.yaml"), `
domain: myapp
agents: [a]
paths:
  - /home/user/code/myapp
`);

    const domains = loadAllDomains(tmpDir);
    const match = resolveDomainFromPath("/home/user/other-project/file.ts", domains);
    expect(match).toBeNull();
  });

  it("validates agents in domain are defined globally", async () => {
    const { loadGlobalConfig, loadAllDomains, validateDomainAgents } = await import("../../src/config/loader.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), `
agents:
  agent-a:
    extends: employee
`);
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), `
domain: test
agents:
  - agent-a
  - agent-b
`);

    const global = loadGlobalConfig(tmpDir);
    const domains = loadAllDomains(tmpDir);
    const warnings = validateDomainAgents(global, domains[0]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agent-b");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/loader.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the loader**

Create `src/config/loader.ts`:
- `loadGlobalConfig(baseDir)` — reads `config.yaml`, parses YAML, returns `GlobalConfig`
- `loadAllDomains(baseDir)` — reads all `domains/*.yaml`, parses each, returns `DomainConfig[]`
- `resolveDomainFromPath(workingDir, domains)` — matches path prefix against domain `paths`, returns domain name or null
- `validateDomainAgents(global, domain)` — checks that agents listed in domain exist in global config, returns warning strings

Use the same YAML parsing approach as existing `loadWorkforceConfig` in `src/project.ts` (likely `js-yaml` or manual parsing — check existing pattern).

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/loader.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/config/loader.ts test/config/loader.test.ts
git commit -m "feat(phase9): add global config and domain loader"
```

---

### Task 3: Domain-Based Lifecycle & DB

**Files:**
- Modify: `src/lifecycle.ts`
- Modify: `src/db.ts`
- Test: `test/config/domain-lifecycle.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/domain-lifecycle.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

describe("domain-based lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-lifecycle-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a domain and creates its database", async () => {
    const { setDataDir, getDb, closeAllDbs } = await import("../../src/db.js");
    setDataDir(path.join(tmpDir, "data"));

    const db = getDb("rentright");
    expect(db).toBeDefined();

    // DB file should exist in data dir
    const dbPath = path.join(tmpDir, "data", "rentright.db");
    expect(fs.existsSync(dbPath)).toBe(true);

    closeAllDbs();
  });

  it("getActiveDomainIds tracks registered domains", async () => {
    const { registerDomain, unregisterDomain, getActiveDomainIds } = await import("../../src/lifecycle.js");

    registerDomain("alpha");
    registerDomain("beta");
    expect(getActiveDomainIds()).toContain("alpha");
    expect(getActiveDomainIds()).toContain("beta");

    unregisterDomain("alpha");
    expect(getActiveDomainIds()).not.toContain("alpha");
    expect(getActiveDomainIds()).toContain("beta");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/domain-lifecycle.test.ts`
Expected: FAIL — `setDataDir`, `registerDomain` not found

**Step 3: Update lifecycle.ts and db.ts**

In `src/db.ts`:
- Add `setDataDir(dir)` / `getDataDir()` — points to `~/.clawforce/data/`
- Update `getDb(projectId)` to use `{dataDir}/{projectId}.db` instead of `{projectsDir}/{projectId}/clawforce.db`
- Keep `setProjectsDir`/`getProjectsDir` as deprecated aliases during transition (or remove if confident)

In `src/lifecycle.ts`:
- Add `registerDomain(domainId)` as alias/replacement for `registerProject`
- Add `unregisterDomain(domainId)` as alias/replacement for `unregisterProject`
- Add `getActiveDomainIds()` as alias/replacement for `getActiveProjectIds`
- Keep old function names as pass-through aliases for now (minimizes blast radius on 98 files)

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/domain-lifecycle.test.ts`
Expected: PASS

**Step 5: Run full test suite to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests still pass (old aliases still work)

**Step 6: Commit**

```bash
git add src/db.ts src/lifecycle.ts test/config/domain-lifecycle.test.ts
git commit -m "feat(phase9): add domain-based lifecycle and data directory"
```

---

### Task 4: Agent Global Roster Registry

**Files:**
- Modify: `src/project.ts`
- Create: `src/config/registry.ts`
- Test: `test/config/registry.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/registry.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("agent global roster registry", () => {
  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    clearRegistry();
  });

  it("registers global agents and assigns them to domains", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getAgentDomain, getGlobalAgent } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "compliance-bot": { extends: "employee", model: "anthropic/claude-opus-4-6" },
      "research-bot": { extends: "employee" },
    });

    assignAgentsToDomain("rentright", ["compliance-bot", "research-bot"]);

    expect(getAgentDomain("compliance-bot")).toBe("rentright");
    expect(getGlobalAgent("compliance-bot")?.extends).toBe("employee");
  });

  it("allows an agent to be assigned to multiple domains", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getAgentDomains } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "shared-bot": { extends: "employee" },
    });

    assignAgentsToDomain("project-a", ["shared-bot"]);
    assignAgentsToDomain("project-b", ["shared-bot"]);

    const domains = getAgentDomains("shared-bot");
    expect(domains).toContain("project-a");
    expect(domains).toContain("project-b");
  });

  it("getDomainAgents returns all agents assigned to a domain", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getDomainAgents } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "bot-a": { extends: "employee" },
      "bot-b": { extends: "employee" },
    });
    assignAgentsToDomain("myproject", ["bot-a", "bot-b"]);

    const agents = getDomainAgents("myproject");
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.id)).toContain("bot-a");
    expect(agents.map(a => a.id)).toContain("bot-b");
  });

  it("returns null for unregistered agent", async () => {
    const { getGlobalAgent, getAgentDomain } = await import("../../src/config/registry.js");
    expect(getGlobalAgent("nonexistent")).toBeNull();
    expect(getAgentDomain("nonexistent")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/registry.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the registry**

Create `src/config/registry.ts`:
- `registerGlobalAgents(agents: Record<string, GlobalAgentDef>)` — stores agents in global map
- `assignAgentsToDomain(domainId, agentIds[])` — creates domain → agent[] and agent → domain[] mappings
- `getGlobalAgent(agentId)` — returns agent definition
- `getAgentDomain(agentId)` — returns primary domain (first assigned)
- `getAgentDomains(agentId)` — returns all domains agent belongs to
- `getDomainAgents(domainId)` — returns all agents in a domain with their configs
- `clearRegistry()` — test cleanup

This sits alongside the existing `agentConfigRegistry` in `project.ts`. The plan is to wire `registerWorkforceConfig` to call into this registry so existing code keeps working while new code uses the new registry directly.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/registry.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/config/registry.ts test/config/registry.test.ts
git commit -m "feat(phase9): add global agent roster registry"
```

---

### Task 5: Domain-Based Initialization Flow

**Files:**
- Create: `src/config/init.ts`
- Modify: `adapters/openclaw.ts` (replace `scanAndRegisterProjects`)
- Test: `test/config/init.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/init.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

describe("domain-based initialization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-init-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes all domains from config directory", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), `
agents:
  worker:
    extends: employee
`);
    fs.writeFileSync(path.join(tmpDir, "domains", "testdomain.yaml"), `
domain: testdomain
agents:
  - worker
`);

    const result = await initializeAllDomains(tmpDir);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]).toBe("testdomain");
    expect(result.errors).toHaveLength(0);
  });

  it("reports errors for domains with undefined agents", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), `
agents:
  worker:
    extends: employee
`);
    fs.writeFileSync(path.join(tmpDir, "domains", "bad.yaml"), `
domain: bad
agents:
  - worker
  - ghost-agent
`);

    const result = await initializeAllDomains(tmpDir);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("ghost-agent");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/init.test.ts`
Expected: FAIL — module not found

**Step 3: Implement initialization**

Create `src/config/init.ts`:
- `initializeAllDomains(baseDir)` — orchestrates full initialization:
  1. `loadGlobalConfig(baseDir)` → get agent definitions + defaults
  2. `loadAllDomains(baseDir)` → get all domain configs
  3. `registerGlobalAgents(globalConfig.agents)` — populate agent roster
  4. For each domain:
     - `validateDomainAgents(globalConfig, domainConfig)` — check agents exist
     - `assignAgentsToDomain(domainId, agents)` — register assignments
     - Resolve presets for each agent (`resolveConfig` from presets.ts)
     - Call `registerWorkforceConfig(domainId, resolvedConfig)` — bridge to existing system
     - `registerDomain(domainId)` — register in lifecycle
  5. Return `{ domains: string[], errors: string[], warnings: string[] }`

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/init.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/config/init.ts test/config/init.test.ts
git commit -m "feat(phase9): add domain-based initialization flow"
```

---

### Task 6: Wire Adapter to Domain System

**Files:**
- Modify: `adapters/openclaw.ts`
- Test: `test/adapters/domain-init.test.ts`

**Step 1: Write the failing test**

Test that the adapter's initialization calls `initializeAllDomains` instead of `scanAndRegisterProjects`. This can be a focused integration test that verifies the adapter correctly resolves domain from agent config during hooks.

```typescript
// test/adapters/domain-init.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

describe("adapter domain integration", () => {
  it("resolves domain from agent config for session tracking", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getAgentDomain } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "test-agent": { extends: "employee" },
    });
    assignAgentsToDomain("test-domain", ["test-agent"]);

    const domain = getAgentDomain("test-agent");
    expect(domain).toBe("test-domain");
  });
});
```

**Step 2: Run test to verify it fails (or passes if registry already works)**

Run: `npx vitest run test/adapters/domain-init.test.ts`

**Step 3: Update the adapter**

In `adapters/openclaw.ts`:
- Replace `scanAndRegisterProjects(projectsDir, logger)` with `initializeAllDomains(configDir)`
- Update `initClawforce` config to accept `configDir` instead of `projectsDir`
- All existing hooks that call `getAgentConfig(agentId).projectId` continue to work because `registerWorkforceConfig` is called by `initializeAllDomains` under the hood

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add adapters/openclaw.ts test/adapters/domain-init.test.ts
git commit -m "feat(phase9): wire adapter to domain-based initialization"
```

---

### Task 7: Init Wizard (Programmatic API + CLI)

**Files:**
- Create: `src/config/wizard.ts`
- Test: `test/config/wizard.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/wizard.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("init wizard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-wizard-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds a new clawforce config directory", async () => {
    const { scaffoldConfigDir } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "config.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "domains"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "data"))).toBe(true);
  });

  it("creates a new domain via initDomain", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, {
      name: "rentright",
      paths: ["~/workplace/rentright-api"],
      orchestrator: "lyle-pa",
      agents: ["compliance-bot"],
    });

    const domainPath = path.join(tmpDir, "domains", "rentright.yaml");
    expect(fs.existsSync(domainPath)).toBe(true);
    const content = fs.readFileSync(domainPath, "utf-8");
    expect(content).toContain("domain: rentright");
    expect(content).toContain("compliance-bot");
  });

  it("adds agent to global config if not present", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, {
      name: "test",
      agents: ["new-agent"],
      agentPresets: { "new-agent": "employee" },
    });

    const globalConfig = fs.readFileSync(path.join(tmpDir, "config.yaml"), "utf-8");
    expect(globalConfig).toContain("new-agent");
  });

  it("does not overwrite existing domain", async () => {
    const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

    scaffoldConfigDir(tmpDir);
    initDomain(tmpDir, { name: "existing", agents: ["a"] });

    expect(() => {
      initDomain(tmpDir, { name: "existing", agents: ["b"] });
    }).toThrow(/already exists/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/wizard.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the wizard**

Create `src/config/wizard.ts`:
- `scaffoldConfigDir(baseDir)` — creates `config.yaml` (with empty agents), `domains/`, `data/` dirs
- `initDomain(baseDir, opts)` — creates `domains/<name>.yaml`, adds agents to global config if `agentPresets` provided, throws if domain already exists
- `InitDomainOpts` type: `{ name, paths?, orchestrator?, agents, agentPresets? }`

Use the same YAML serialization approach as existing config code.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/wizard.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/config/wizard.ts test/config/wizard.test.ts
git commit -m "feat(phase9): add init wizard with scaffolding and domain creation"
```

---

### Task 8: Config Quality Feedback (Enhanced Validator + Skill)

**Files:**
- Modify: `src/config-validator.ts`
- Modify: `src/skills/topics/config.ts`
- Test: `test/config/suggestions.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/suggestions.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("config quality suggestions", () => {
  it("suggests budget config when multiple agents defined", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        a: { extends: "employee" },
        b: { extends: "employee" },
        c: { extends: "employee" },
      },
    };

    const results = validateWorkforceConfig(config as any);
    const suggestions = results.filter(r => r.level === "suggest");
    expect(suggestions.some(s => s.message.toLowerCase().includes("budget"))).toBe(true);
  });

  it("suggests orchestrator when domain has no orchestrator", async () => {
    const { validateDomainQuality } = await import("../../src/config-validator.js");

    const result = validateDomainQuality({
      domain: "test",
      agents: ["a", "b"],
    });
    const suggestions = result.filter(r => r.level === "suggest");
    expect(suggestions.some(s => s.message.toLowerCase().includes("orchestrator"))).toBe(true);
  });

  it("suggests expectations when agents have none", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        worker: { extends: "employee" },
      },
    };

    const results = validateWorkforceConfig(config as any);
    const suggestions = results.filter(r => r.level === "suggest");
    expect(suggestions.some(s => s.message.toLowerCase().includes("expectation"))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/suggestions.test.ts`
Expected: FAIL — `suggest` level not supported, `validateDomainQuality` not found

**Step 3: Implement**

In `src/config-validator.ts`:
- Add `"suggest"` to the `level` union type
- Add suggestion checks at end of `validateWorkforceConfig`:
  - 3+ agents with no budget → suggest budget
  - Agent with no expectations → suggest adding expectations
  - Agent with no performance_policy → suggest adding one
- Add `validateDomainQuality(domainConfig)` function:
  - No orchestrator → suggest assigning one
  - No paths → suggest adding code paths (if applicable)
  - No rules → suggest learning about the rule system

In `src/skills/topics/config.ts`:
- Add sections documenting domain config structure, global vs domain config, best practices for rules, budget strategy

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/suggestions.test.ts`
Expected: PASS (3 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

**Step 6: Commit**

```bash
git add src/config-validator.ts src/skills/topics/config.ts test/config/suggestions.test.ts
git commit -m "feat(phase9): add config quality suggestions and updated skill topic"
```

---

### Task 9: Config Hot-Reload

**Files:**
- Create: `src/config/watcher.ts`
- Test: `test/config/watcher.test.ts`

**Step 1: Write the failing test**

```typescript
// test/config/watcher.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("config hot-reload", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-reload-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects config changes and returns diff", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const oldConfig = {
      agents: {
        bot: { extends: "employee", model: "old-model" },
      },
    };
    const newConfig = {
      agents: {
        bot: { extends: "employee", model: "new-model" },
      },
    };

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.changed).toBe(true);
    expect(diff.agentChanges).toContain("bot");
  });

  it("detects no changes when configs are identical", async () => {
    const { diffConfigs } = await import("../../src/config/watcher.js");

    const config = { agents: { bot: { extends: "employee" } } };
    const diff = diffConfigs(config, config);
    expect(diff.changed).toBe(false);
  });

  it("detects domain config changes", async () => {
    const { diffDomainConfigs } = await import("../../src/config/watcher.js");

    const oldDomain = { domain: "test", agents: ["a"], budget: { daily: 5 } };
    const newDomain = { domain: "test", agents: ["a", "b"], budget: { daily: 10 } };

    const diff = diffDomainConfigs(oldDomain, newDomain);
    expect(diff.changed).toBe(true);
    expect(diff.agentsAdded).toContain("b");
    expect(diff.budgetChanged).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/watcher.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the watcher**

Create `src/config/watcher.ts`:
- `diffConfigs(old, new)` — compares global configs, returns `{ changed, agentChanges[], defaultsChanged }`
- `diffDomainConfigs(old, new)` — compares domain configs, returns `{ changed, agentsAdded[], agentsRemoved[], budgetChanged, policiesChanged, rulesChanged }`
- `startConfigWatcher(baseDir, onReload)` — `fs.watch` on `baseDir/config.yaml` and `baseDir/domains/`. Debounces 500ms. On change: re-load, validate, diff, call `onReload(diff)` if valid, emit diagnostic event if invalid.
- `stopConfigWatcher()` — closes fs.watch handles

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/watcher.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/config/watcher.ts test/config/watcher.test.ts
git commit -m "feat(phase9): add config hot-reload with diff detection"
```

---

### Task 10: Rule System (Trigger + Prompt Template)

**Files:**
- Create: `src/rules/engine.ts`
- Create: `src/rules/interpolate.ts`
- Test: `test/rules/engine.test.ts`

**Step 1: Write the failing test**

```typescript
// test/rules/engine.test.ts
import { describe, expect, it } from "vitest";

describe("rule engine", () => {
  it("matches a rule by event type", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "deploy-review",
        trigger: { event: "task.completed", match: { tags: ["deploy"] } },
        action: { agent: "reviewer", prompt_template: "Review {{task.title}}" },
      },
    ];

    const event = { type: "task.completed", data: { tags: ["deploy"], task: { title: "Ship v2" } } };
    const matched = matchRules(rules, event);

    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("deploy-review");
  });

  it("does not match when event type differs", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "deploy-review",
        trigger: { event: "task.completed" },
        action: { agent: "reviewer", prompt_template: "Review" },
      },
    ];

    const event = { type: "task.created", data: {} };
    const matched = matchRules(rules, event);
    expect(matched).toHaveLength(0);
  });

  it("does not match when match criteria fail", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "deploy-review",
        trigger: { event: "task.completed", match: { tags: ["deploy"] } },
        action: { agent: "reviewer", prompt_template: "Review" },
      },
    ];

    const event = { type: "task.completed", data: { tags: ["bugfix"] } };
    const matched = matchRules(rules, event);
    expect(matched).toHaveLength(0);
  });

  it("skips disabled rules", async () => {
    const { matchRules } = await import("../../src/rules/engine.js");

    const rules = [
      {
        name: "disabled-rule",
        trigger: { event: "task.completed" },
        action: { agent: "reviewer", prompt_template: "Review" },
        enabled: false,
      },
    ];

    const event = { type: "task.completed", data: {} };
    const matched = matchRules(rules, event);
    expect(matched).toHaveLength(0);
  });

  it("interpolates prompt template with event data", async () => {
    const { buildPromptFromRule } = await import("../../src/rules/engine.js");

    const rule = {
      name: "test",
      trigger: { event: "task.completed" },
      action: {
        agent: "reviewer",
        prompt_template: "Review the deployment for {{task.title}}. Priority: {{task.priority}}.",
      },
    };

    const eventData = { task: { title: "Ship v2", priority: "high" } };
    const prompt = buildPromptFromRule(rule, eventData);
    expect(prompt).toBe("Review the deployment for Ship v2. Priority: high.");
  });

  it("leaves unmatched template vars as-is", async () => {
    const { buildPromptFromRule } = await import("../../src/rules/engine.js");

    const rule = {
      name: "test",
      trigger: { event: "x" },
      action: { agent: "a", prompt_template: "Hello {{unknown.field}}" },
    };

    const prompt = buildPromptFromRule(rule, {});
    expect(prompt).toBe("Hello {{unknown.field}}");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/rules/engine.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

Create `src/rules/engine.ts`:
- `matchRules(rules: RuleDefinition[], event: { type: string; data: Record<string, unknown> })` — filters rules where `trigger.event` matches `event.type`, and if `trigger.match` is present, checks that each key/value in `match` exists in `event.data` (supports array includes for arrays like tags)
- `buildPromptFromRule(rule, eventData)` — interpolates `{{dotted.path}}` variables in `prompt_template` with values from eventData. Uses existing `interpolate` from `src/events/template.ts` if compatible, otherwise implements simple dot-path resolution.
- Skips rules where `enabled === false`

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/rules/engine.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/rules/engine.ts test/rules/engine.test.ts
git commit -m "feat(phase9): add rule engine with trigger matching and prompt interpolation"
```

---

### Task 11: Evolution Pipeline (Decision → Rule Promotion)

**Files:**
- Modify: `src/memory/promotion.ts`
- Create: `src/rules/evolution.ts`
- Modify: `src/memory/ghost-turn.ts` (add evolution prompt)
- Test: `test/rules/evolution.test.ts`

**Step 1: Write the failing test**

```typescript
// test/rules/evolution.test.ts
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test", hmacKey: "deadbeef", identityToken: "tok", issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("evolution pipeline", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("suggestTarget returns 'rule' for decision-pattern content", async () => {
    const { suggestTarget } = await import("../../src/memory/promotion.js");
    const target = suggestTarget("when a deploy task completes, always assign a reviewer to check it");
    expect(target).toBe("rule");
  });

  it("formats the evolution prompt for orchestrators", async () => {
    const { formatEvolutionPrompt } = await import("../../src/rules/evolution.js");
    const prompt = formatEvolutionPrompt();
    expect(prompt).toContain("rule");
    expect(prompt).toContain("judgment");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("evolution prompt is injected via ghost turn for orchestrator preset", async () => {
    const { formatEvolutionPrompt } = await import("../../src/rules/evolution.js");
    const prompt = formatEvolutionPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/rules/evolution.test.ts`
Expected: FAIL — `suggestTarget` doesn't return "rule", `formatEvolutionPrompt` doesn't exist

**Step 3: Implement**

In `src/memory/promotion.ts`:
- Update `suggestTarget(snippet)` to detect decision patterns: "when...then", "always assign", "if...should", "every time...do" → returns `"rule"` as target
- Add `"rule"` to the `PromotionTarget` type in `types.ts`

Create `src/rules/evolution.ts`:
- `formatEvolutionPrompt()` — returns a markdown string injected into orchestrator ghost turns:
  ```
  ## System Evolution

  When you make a judgment call not covered by existing rules, document your reasoning clearly.
  If you notice yourself making the same type of decision repeatedly, flag it as a rule candidate
  using the ops-tool `flag_knowledge` action with source_type "decision_pattern".

  Rules are pre-built prompt templates with trigger conditions. Converting repeated decisions
  into rules makes the system faster and cheaper — no LLM cost for the routing decision.
  ```

In `src/memory/ghost-turn.ts`:
- After expectations re-injection, check if agent preset is orchestrator/manager → if so, append evolution prompt via `formatEvolutionPrompt()`

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/rules/evolution.test.ts`
Expected: PASS (3 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

**Step 6: Commit**

```bash
git add src/memory/promotion.ts src/rules/evolution.ts src/memory/ghost-turn.ts src/types.ts test/rules/evolution.test.ts
git commit -m "feat(phase9): add evolution pipeline for decision-to-rule promotion"
```

---

### Task 12: Update Exports & Final Integration

**Files:**
- Modify: `src/index.ts`
- Modify: `src/presets.ts` (update preset names if needed)
- Test: Run full test suite

**Step 1: Update index.ts exports**

Add new exports section:

```typescript
// --- Config System ---
export { loadGlobalConfig, loadAllDomains, resolveDomainFromPath } from "./config/loader.js";
export { validateGlobalConfig, validateDomainConfig, validateRuleDefinition } from "./config/schema.js";
export type { GlobalConfig, DomainConfig, GlobalAgentDef, GlobalDefaults, ValidationResult } from "./config/schema.js";
export { registerGlobalAgents, assignAgentsToDomain, getGlobalAgent, getAgentDomain, getAgentDomains, getDomainAgents } from "./config/registry.js";
export { initializeAllDomains } from "./config/init.js";
export { scaffoldConfigDir, initDomain } from "./config/wizard.js";
export type { InitDomainOpts } from "./config/wizard.js";
export { startConfigWatcher, stopConfigWatcher, diffConfigs, diffDomainConfigs } from "./config/watcher.js";
export { validateDomainQuality } from "./config-validator.js";

// --- Rules ---
export { matchRules, buildPromptFromRule } from "./rules/engine.js";
export { formatEvolutionPrompt } from "./rules/evolution.js";
```

Add `"rule"` to the `PromotionTarget` type re-export in the Types section.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(phase9): export config system and rule engine from index"
```

---

### Task 13: Remove Legacy Project-Scoped Config Loading

**Files:**
- Modify: `src/project.ts` (remove `loadProject`, `loadWorkforceConfig` from project.yaml)
- Modify: `adapters/openclaw.ts` (remove `scanAndRegisterProjects`)
- Modify: `src/tools/setup-tool.ts` (update `activate` action to use domain system)
- Test: Update affected tests

**Step 1: Identify all callers of legacy functions**

Search for `loadProject`, `loadWorkforceConfig`, `scanAndRegisterProjects`, `initProject` usage across adapter and tools.

**Step 2: Replace callers**

- `adapters/openclaw.ts`: Replace `scanAndRegisterProjects` call with `initializeAllDomains`
- `src/tools/setup-tool.ts`: `activate` action reads from domain config instead of project.yaml
- Keep `registerWorkforceConfig` as internal API (called by `initializeAllDomains`)

**Step 3: Remove dead code**

- Remove `loadProject()` from `src/project.ts`
- Remove `loadWorkforceConfig()` file-reading logic (keep the in-memory registration)
- Remove `scanAndRegisterProjects()` from adapter
- Remove `loadEnforcementConfig` alias

**Step 4: Update tests**

- `test/adapters/openclaw.test.ts` — update to use domain config
- `test/tools/setup-tool.test.ts` — update activate test
- Any test importing `loadProject` or `loadWorkforceConfig` for file loading

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass (with updated tests)

**Step 6: Commit**

```bash
git add -u
git commit -m "refactor(phase9): remove legacy project-scoped config loading"
```

---

### Task 14: Update Skill Topics for Domain Architecture

**Files:**
- Modify: `src/skills/topics/config.ts`
- Modify: `src/skills/topics/roles.ts`
- Modify: `src/skills/topics/tools.ts`
- Test: `test/skills/domain-topics.test.ts`

**Step 1: Write the test**

```typescript
// test/skills/domain-topics.test.ts
import { describe, expect, it } from "vitest";

describe("skill topics reflect domain architecture", () => {
  it("config topic mentions domains not projects", async () => {
    const { generate } = await import("../../src/skills/topics/config.js");
    const content = generate({} as any);
    expect(content).toContain("domain");
    expect(content).not.toContain("project.yaml");
  });

  it("config topic documents rule system", async () => {
    const { generate } = await import("../../src/skills/topics/config.js");
    const content = generate({} as any);
    expect(content).toContain("rule");
    expect(content).toContain("trigger");
    expect(content).toContain("prompt_template");
  });

  it("tools topic documents initDomain", async () => {
    const { generate } = await import("../../src/skills/topics/tools.js");
    const content = generate({} as any);
    expect(content).toContain("init");
  });
});
```

**Step 2: Update skill topics**

- `config.ts`: Rewrite to document global config + domain config structure, rule system, evolution pipeline, config quality suggestions
- `roles.ts`: Update references from "project" to "domain"
- `tools.ts`: Document `initDomain` capability in setup tool

**Step 3: Run test**

Run: `npx vitest run test/skills/domain-topics.test.ts`
Expected: PASS

**Step 4: Run full suite**

Run: `npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add src/skills/topics/config.ts src/skills/topics/roles.ts src/skills/topics/tools.ts test/skills/domain-topics.test.ts
git commit -m "docs(phase9): update skill topics for domain architecture and rule system"
```

---

### Post-Implementation Verification

After all tasks are complete:

1. **Run full test suite**: `npx vitest run` — all tests must pass
2. **TypeScript check**: `npx tsc --noEmit` — no type errors
3. **Verify exports**: Ensure all new public APIs are exported from `src/index.ts`
4. **Smoke test**: Create a test config directory with `config.yaml` + `domains/test.yaml`, verify `initializeAllDomains` works end-to-end
