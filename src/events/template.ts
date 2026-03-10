/**
 * Clawforce — Event template interpolation
 *
 * Simple {{path.to.field}} substitution for event handler configs.
 * Supports: {{payload.field}}, {{event.type}}, {{event.projectId}}, etc.
 */

export type TemplateContext = {
  event: { id: string; type: string; source: string; projectId: string };
  payload: Record<string, unknown>;
};

/**
 * Interpolate {{path}} references in a template string.
 * Unknown paths resolve to empty string.
 */
export function interpolate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim();
    const parts = trimmed.split(".");
    let value: unknown = ctx as Record<string, unknown>;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return "";
      value = (value as Record<string, unknown>)[part];
    }
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Interpolate a Record's values (used for emit_event payload templates).
 */
export function interpolateRecord(
  record: Record<string, string>,
  ctx: TemplateContext,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    result[key] = interpolate(val, ctx);
  }
  return result;
}
