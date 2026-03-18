/**
 * Clawforce — DIRECTION.md schema and loader
 *
 * Parses a DIRECTION.md file (YAML or plain text) into a structured
 * Direction object that drives team setup and manager behavior.
 */

import YAML from "yaml";

export type DirectionConstraints = {
  budget_daily_cents?: number;
  tech_stack?: string[];
  timeline?: string;
  [key: string]: unknown;
};

export type DirectionPhase = {
  name: string;
  goals: string[];
};

export type Autonomy = "low" | "medium" | "high";

export type Direction = {
  vision: string;
  constraints?: DirectionConstraints;
  phases?: DirectionPhase[];
  autonomy: Autonomy;
};

const VALID_AUTONOMY: Set<string> = new Set(["low", "medium", "high"]);

export function parseDirection(content: string): Direction {
  const trimmed = content.trim();

  try {
    const parsed = YAML.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.vision === "string") {
      return {
        vision: parsed.vision,
        constraints: parsed.constraints,
        phases: parsed.phases,
        autonomy: VALID_AUTONOMY.has(parsed.autonomy) ? parsed.autonomy : "low",
      };
    }
  } catch {
    // Not valid YAML — treat as plain text
  }

  return { vision: trimmed, autonomy: "low" };
}

export type DirectionValidation = {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
};

export function validateDirection(dir: Partial<Direction>): DirectionValidation {
  const errors: DirectionValidation["errors"] = [];

  if (!dir.vision || dir.vision.trim().length === 0) {
    errors.push({ field: "vision", message: "vision is required and must be non-empty" });
  }

  if (dir.autonomy && !VALID_AUTONOMY.has(dir.autonomy)) {
    errors.push({ field: "autonomy", message: "autonomy must be one of: low, medium, high" });
  }

  if (dir.phases) {
    for (let i = 0; i < dir.phases.length; i++) {
      const phase = dir.phases[i];
      if (!phase.name) {
        errors.push({ field: `phases[${i}].name`, message: "phase name is required" });
      }
      if (!Array.isArray(phase.goals) || phase.goals.length === 0) {
        errors.push({ field: `phases[${i}].goals`, message: "phase must have at least one goal" });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
