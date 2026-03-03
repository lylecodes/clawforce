/**
 * Clawforce skill topic — Workflows
 *
 * Documents multi-phase workflow execution.
 */

export function generate(): string {
  // Gate conditions from WorkflowPhase type: "all_done" | "any_done" | "all_resolved" | "any_resolved"
  const gates: Array<{ name: string; description: string }> = [
    { name: "all_done", description: "All tasks in the phase must reach `DONE` state. This is the default." },
    { name: "any_done", description: "At least one task in the phase must reach `DONE` state." },
    { name: "all_resolved", description: "All tasks must be resolved (`DONE` or `FAILED`), with at least one `DONE`." },
    { name: "any_resolved", description: "At least one task must be resolved (`DONE` or `FAILED`), with at least one `DONE`." },
  ];

  const sections: string[] = [
    "# Workflows",
    "",
    "Workflows enable multi-phase execution with automatic gating. Tasks in later phases are blocked until earlier phases complete according to their gate condition.",
    "",

    "## Workflow Structure",
    "",
    "A workflow has:",
    "",
    "- **name**: Human-readable workflow name",
    "- **phases**: Ordered list of phases, each containing tasks",
    "- **currentPhase**: Index of the currently active phase (0-based)",
    "- **state**: `active`, `completed`, or `failed`",
    "",

    "## Phase Structure",
    "",
    "Each phase has:",
    "",
    "| Field | Type | Description |",
    "| --- | --- | --- |",
    "| `name` | string | Phase name |",
    "| `description` | string (optional) | What this phase accomplishes |",
    "| `taskIds` | string[] | Tasks belonging to this phase |",
    "| `gateCondition` | string | When the phase is considered complete (default: `all_done`) |",
    "",

    "## Gate Conditions",
    "",
    "Gate conditions determine when a phase is satisfied and the next phase can begin:",
    "",
    "| Condition | Description |",
    "| --- | --- |",
  ];

  for (const gate of gates) {
    sections.push(`| \`${gate.name}\` | ${gate.description} |`);
  }

  sections.push("");
  sections.push("## Blocking Behavior");
  sections.push("");
  sections.push("Tasks in future phases are automatically blocked. When a task belongs to phase N but the workflow is currently on phase M (where M < N), the task cannot be transitioned. The system checks `isTaskInFuturePhase` before allowing state transitions.");
  sections.push("");
  sections.push("## Advancing Phases");
  sections.push("");
  sections.push("- **Auto-advance**: Use `clawforce_workflow advance` to check the current phase's gate condition and advance if satisfied.");
  sections.push("- **Force-advance**: Use `clawforce_workflow force_advance` to skip the gate check and move to the next phase regardless. This is audited.");
  sections.push("");
  sections.push("## Workflow Lifecycle");
  sections.push("");
  sections.push("1. Create a workflow with named phases: `clawforce_workflow create`");
  sections.push("2. Add tasks to phases: `clawforce_workflow add_task`");
  sections.push("3. Work on phase 0 tasks normally");
  sections.push("4. When the gate condition is met, advance: `clawforce_workflow advance`");
  sections.push("5. Repeat until all phases are complete");
  sections.push("6. Workflow state changes to `completed` when the final phase is satisfied");
  sections.push("");

  return sections.join("\n");
}
