/**
 * Clawforce — Onboarding context
 *
 * Short prompt injected via before_prompt_build when no projects are registered.
 * Points the agent to the `clawforce_setup explain` action for full reference docs.
 */

import { SKILL_TOPICS } from "../skills/registry.js";

/**
 * Build a short onboarding prompt for agents.
 * Keeps injected context minimal — the full reference is in `clawforce_setup explain`.
 */
export function buildOnboardingContext(projectsDir: string): string {
  return `## Clawforce — Setup Available

Your AI workforce is ready but no projects are configured yet. You can help the user onboard their project.

**Clawforce** gives autonomous agents accountability: task tracking, accountability (agents must complete their deliverables or get retried/escalated), audit trails, and workflows.

**To get started**, offer to help the user set up their AI workforce for their project. You'll need to know:
- What project directory they're working in
- What workflow they want to run (for example \`data-source-onboarding\`)
- Which agents or specialists should own that workflow
- What agent IDs those agents have in your platform (ask them to check, or use \`clawforce_setup\` action \`status\` which may surface this)

**Setup tool actions:**
- \`clawforce_setup\` action \`explain\` — Get the full reference: \`config.yaml\` + \`domains/*.yaml\` format, agent roles, context sources, accountability options, examples
- \`clawforce_setup\` action \`status\` — See what's currently configured
- \`clawforce_setup\` action \`validate\` — Check a config before writing it
- \`clawforce_setup\` action \`scaffold\` — Create a starter domain, including workflow-specific starters like \`data-source-onboarding\`
- \`clawforce_setup\` action \`activate\` — Register a domain live after writing \`${projectsDir}/config.yaml\` and \`${projectsDir}/domains/<project_id>.yaml\`

Call \`clawforce_setup\` with action \`explain\` first to get the full reference before building a config.`;
}

/**
 * Full reference documentation for the explain action.
 * Delegates to the skill system for domain knowledge, then appends
 * setup-specific instructions that require the projectsDir.
 */
export function buildExplainContent(projectsDir: string): string {
  // Generate all skill topics (manager role has access to everything)
  const topicSections = SKILL_TOPICS.map((t) => t.generate());

  const setupSection = `
## Setup Instructions

### Agent IDs

Agent IDs in the YAML must match the actual agent IDs configured in your platform. The user should know these from their agent setup. If they're unsure, they can check their agent configuration or create new agent IDs and configure them to match.

### Setup Steps

1. Ask the user about their project and the workflow they want ClawForce to drive
2. Create the config directory: \`${projectsDir}/\`
3. Write shared agent definitions to \`${projectsDir}/config.yaml\`
4. Write domain membership and per-domain settings to \`${projectsDir}/domains/<project-id>.yaml\`
5. Call \`clawforce_setup\` with action \`validate\` and the YAML content or file path to check for errors
6. Call \`clawforce_setup\` with action \`activate\` and the \`project_id\` to register the domain live

### Tips

- Start simple: one manager + one employee is enough to get value
- If the user needs a known workflow shape, scaffold it first instead of hand-writing every job and agent
- \`cf setup scaffold --domain=<id> --mode=new --workflow=data-source-onboarding\` creates a first-class source-onboarding starter with intake, onboarding, integrity, and production jobs
- Put shared agent definitions in \`config.yaml\` and domain membership in \`domains/<domain>.yaml\`
- Use \`validate\` before writing to disk to catch errors early
- You can re-activate an already-active domain to reload its config after changes`;

  return `## Clawforce — Full Reference\n\n${topicSections.join("\n\n")}\n${setupSection}`;
}
