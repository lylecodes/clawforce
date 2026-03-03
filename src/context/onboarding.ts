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
- What employees they use and what each one does
- What agent IDs those agents have in your platform (ask them to check, or use \`clawforce_setup\` action \`status\` which may surface this)

**Setup tool actions:**
- \`clawforce_setup\` action \`explain\` — Get the full reference: project.yaml format, agent roles, context sources, accountability options, examples
- \`clawforce_setup\` action \`status\` — See what's currently configured
- \`clawforce_setup\` action \`validate\` — Check a config before writing it
- \`clawforce_setup\` action \`activate\` — Register a project live after writing its config to \`${projectsDir}/<project_id>/project.yaml\`

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

1. Ask the user about their project and employees
2. Create the project directory: \`${projectsDir}/<project-id>/\`
3. Write \`project.yaml\` there
4. Call \`clawforce_setup\` with action \`validate\` and the \`yaml_content\` to check for errors
5. Call \`clawforce_setup\` with action \`activate\` and the \`project_id\` to register it live

### Tips

- Start simple: one manager + one employee is enough to get value
- The \`dir\` field should be the absolute path to the project's code directory
- Use \`validate\` before writing to disk to catch errors early
- You can re-activate an already-active project to reload its config after changes`;

  return `## Clawforce — Full Reference\n\n${topicSections.join("\n\n")}\n${setupSection}`;
}
