/**
 * Clawforce — Action categories
 *
 * Standard action categories for tool gating.
 * Used by config validation and bulk detection.
 */

/**
 * Built-in action categories grouped by domain.
 * These are the standard categories referenced in tool_gates config.
 * Users can define custom categories — these are just the built-in set.
 */
export const ACTION_CATEGORIES = {
  communication: ["email:send", "email:forward", "message:send", "social:post"],
  calendar: [
    "calendar:create_event",
    "calendar:cancel_event",
    "calendar:reschedule",
  ],
  financial: [
    "financial:purchase",
    "financial:transfer",
    "financial:subscribe",
    "financial:pay_bill",
  ],
  code: ["code:merge_pr", "code:deploy", "code:push", "code:release"],
  data: ["data:delete", "data:share", "data:permission_change"],
  booking: ["booking:create", "booking:cancel", "booking:modify"],
} as const;

/** Flat set of all built-in category strings for validation. */
export const KNOWN_CATEGORIES: Set<string> = new Set(
  Object.values(ACTION_CATEGORIES).flat(),
);

/**
 * Check if a category string is a known built-in category.
 */
export function isKnownCategory(category: string): boolean {
  return KNOWN_CATEGORIES.has(category);
}

/**
 * Get the domain group for a category (e.g., "email:send" → "communication").
 */
export function getCategoryDomain(
  category: string,
): string | null {
  for (const [domain, categories] of Object.entries(ACTION_CATEGORIES)) {
    if ((categories as readonly string[]).includes(category)) return domain;
  }
  return null;
}
