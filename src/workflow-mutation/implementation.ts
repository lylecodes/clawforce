import type { DatabaseSync } from "../sqlite-driver.js";
import { getTask, getTaskEvidence } from "../tasks/ops.js";
import type { Task } from "../types.js";

type WorkflowMutationImplementationDescriptionParams = {
  subject: string;
  sourceTaskId: string;
  sourceTaskTitle: string;
  reviewTaskId: string;
  reviewTaskTitle: string;
  reviewDescription?: string | null;
  reviewEvidence?: string;
  reasonCode: string;
  mutationCategory: string;
};

export function buildWorkflowMutationImplementationDescription(
  params: WorkflowMutationImplementationDescriptionParams,
): string {
  const acceptedRecommendation = buildWorkflowMutationImplementationRecommendation(
    params.reviewDescription,
    params.reviewEvidence,
    params.reviewTaskId,
  );

  return [
    `Accepted workflow-mutation review for ${params.subject}.`,
    "",
    `Source task: ${params.sourceTaskTitle} (${params.sourceTaskId})`,
    `Review task: ${params.reviewTaskTitle} (${params.reviewTaskId})`,
    `Reason code: ${params.reasonCode}`,
    `Mutation category: ${params.mutationCategory}`,
    "",
    "Accepted recommendation summary:",
    acceptedRecommendation,
    "",
    "Acceptance criteria:",
    "- Apply the minimal workflow/setup mutation described in the accepted review output.",
    "- Re-enable the governed rerun path for the blocked source task without requiring manual operator steering.",
    "- When this task completes, ClawForce should rerun the linked source-task verification path automatically.",
    "- Leave a concise operator-facing summary in task evidence or task description.",
  ].join("\n");
}

export function maybeNormalizeWorkflowMutationImplementationTask(
  projectId: string,
  task: Task,
  db: DatabaseSync,
): Task {
  const metadata = asObject(task.metadata);
  if (metadata?.workflowMutationStage !== "implementation") return task;
  if (!needsWorkflowMutationImplementationRefresh(task.description)) return task;

  const reviewTaskId = typeof metadata.reviewTaskId === "string" ? metadata.reviewTaskId : null;
  const sourceTaskId = typeof metadata.sourceTaskId === "string" ? metadata.sourceTaskId : null;
  const sourceTaskTitle = typeof metadata.sourceTaskTitle === "string" ? metadata.sourceTaskTitle : null;
  const reasonCode = typeof metadata.reasonCode === "string" ? metadata.reasonCode : null;
  const mutationCategory = typeof metadata.mutationCategory === "string" ? metadata.mutationCategory : null;
  if (!reviewTaskId || !sourceTaskId || !sourceTaskTitle || !reasonCode || !mutationCategory) return task;

  const reviewTask = getTask(projectId, reviewTaskId, db);
  if (!reviewTask) return task;

  const subject = extractWorkflowMutationSubject(task.title, sourceTaskTitle);
  const nextDescription = buildWorkflowMutationImplementationDescription({
    subject,
    sourceTaskId,
    sourceTaskTitle,
    reviewTaskId,
    reviewTaskTitle: reviewTask.title,
    reviewDescription: reviewTask.description,
    reviewEvidence: getLatestTaskEvidenceContent(projectId, reviewTask.id, db),
    reasonCode,
    mutationCategory,
  });

  if ((task.description ?? "") === nextDescription) return task;

  db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(nextDescription, Date.now(), projectId, task.id);

  return getTask(projectId, task.id, db) ?? { ...task, description: nextDescription };
}

export function needsWorkflowMutationImplementationRefresh(description: string | undefined): boolean {
  const trimmed = description?.trim();
  if (!trimmed) return false;
  if (trimmed.includes("Accepted recommendation summary:")) return false;
  return looksLikeCodexTranscript(trimmed)
    || trimmed.includes("Accepted recommendation:")
    || trimmed.includes("<system_context>")
    || trimmed.includes("<task>")
    || trimmed.length > 2500;
}

export function buildWorkflowMutationImplementationRecommendation(
  reviewDescription: string | null | undefined,
  reviewEvidence: string | undefined,
  reviewTaskId: string,
): string {
  const descriptionSummary = extractWorkflowMutationDescriptionSummary(reviewDescription);
  if (descriptionSummary) {
    return [
      descriptionSummary,
      "",
      `See review task ${reviewTaskId} evidence for the full review transcript if more context is needed.`,
    ].join("\n");
  }

  const evidenceSummary = extractCompactReviewEvidenceSummary(reviewEvidence);
  if (evidenceSummary) {
    return [
      evidenceSummary,
      "",
      `See review task ${reviewTaskId} evidence for the full review transcript if more context is needed.`,
    ].join("\n");
  }

  return `See review task ${reviewTaskId} evidence for the accepted workflow-mutation rationale and implementation details.`;
}

export function looksLikeCodexTranscript(content: string): boolean {
  return content.includes("Reading additional input from stdin")
    || content.includes("OpenAI Codex")
    || content.includes("workdir:")
    || content.includes("session id:")
    || content.includes("<system_context>")
    || content.includes("<task>")
    || content.includes("## Work Board")
    || content.includes("## Entity Registry")
    || content.includes("web search:");
}

function extractWorkflowMutationDescriptionSummary(
  description: string | null | undefined,
): string | undefined {
  if (!description) return undefined;
  const recommendedSection = description.match(/Recommended changes:\n([\s\S]*?)\n\nAcceptance criteria:/);
  const recommended = recommendedSection?.[1]?.trim();
  if (recommended && !looksLikeCodexTranscript(recommended) && recommended.length <= 1000) {
    return recommended;
  }

  return undefined;
}

function extractCompactReviewEvidenceSummary(content: string | undefined): string | undefined {
  const trimmed = content?.trim();
  if (!trimmed) return undefined;

  const finalSummary = trimmed.match(/(?:^|\n)Final summary:?\s*\n([\s\S]*?)$/i)?.[1]?.trim();
  if (finalSummary) {
    return clampSummary(finalSummary, 600);
  }

  const resultSection = extractSection(trimmed, "**Result**") ?? extractSection(trimmed, "## Result");
  if (resultSection && !looksLikeCodexTranscript(resultSection)) {
    return clampSummary(resultSection, 600);
  }

  if (looksLikeCodexTranscript(trimmed) || trimmed.length > 600) {
    return undefined;
  }

  return trimmed;
}

function extractSection(content: string, heading: string): string | undefined {
  const escaped = escapeRegex(heading);
  const match = content.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\n+([\\s\\S]*?)(?:\\n\\n(?:\\*\\*[^*]+\\*\\*|##\\s)|$)`));
  return match?.[1]?.trim() || undefined;
}

function clampSummary(content: string, maxChars: number): string {
  const normalized = content.replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 3).trimEnd()}...`
    : normalized;
}

function extractWorkflowMutationSubject(title: string, fallback: string): string {
  const match = title.match(/^Implement workflow mutation for (.+?): /);
  return match?.[1]?.trim() || fallback;
}

function getLatestTaskEvidenceContent(
  projectId: string,
  taskId: string,
  db: DatabaseSync,
): string | undefined {
  const evidence = getTaskEvidence(projectId, taskId, db);
  return evidence
    .filter((item) => item.type === "output")
    .at(-1)?.content?.trim()
    || evidence.at(-1)?.content?.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
