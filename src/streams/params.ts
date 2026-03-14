/**
 * Clawforce — Stream Parameter Validation
 *
 * Validates user-supplied params against a stream's parameter schema.
 */

import { getStream } from "./catalog.js";

export type ParamValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateStreamParams(
  streamName: string,
  params: Record<string, unknown>,
): ParamValidationResult {
  const stream = getStream(streamName);
  if (!stream || !stream.params || stream.params.length === 0) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];

  for (const schema of stream.params) {
    const value = params[schema.name];

    if (value === undefined || value === null) {
      if (schema.required) {
        errors.push(`Required parameter "${schema.name}" is missing for stream "${streamName}"`);
      }
      continue;
    }

    // Type check
    switch (schema.type) {
      case "string":
        if (typeof value !== "string") {
          errors.push(`Parameter "${schema.name}" must be a string, got ${typeof value}`);
        }
        break;
      case "number":
        if (typeof value !== "number") {
          errors.push(`Parameter "${schema.name}" must be a number, got ${typeof value}`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          errors.push(`Parameter "${schema.name}" must be a boolean, got ${typeof value}`);
        }
        break;
      case "string[]":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          errors.push(`Parameter "${schema.name}" must be a string array`);
        }
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}
