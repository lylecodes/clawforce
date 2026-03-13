/**
 * Clawforce — Rule Engine
 *
 * Matches events against domain rules and builds prompts from templates.
 * Rules are pre-built prompt templates with trigger conditions — they
 * automate recurring decisions without LLM cost.
 */

import type { RuleDefinition } from "../types.js";

export type RuleEvent = {
  type: string;
  data: Record<string, unknown>;
};

export type MatchedRule = RuleDefinition & {
  /** The interpolated prompt ready to dispatch */
  prompt: string;
};

/**
 * Match rules against an event. Returns all matching rules.
 * Skips disabled rules (enabled === false).
 */
export function matchRules(rules: RuleDefinition[], event: RuleEvent): RuleDefinition[] {
  return rules.filter(rule => {
    // Skip disabled rules
    if (rule.enabled === false) return false;

    // Match event type
    if (rule.trigger.event !== event.type) return false;

    // Match criteria (if specified)
    if (rule.trigger.match) {
      for (const [key, expected] of Object.entries(rule.trigger.match)) {
        const actual = event.data[key];

        // Array contains check: if expected is an array element and actual is an array
        if (Array.isArray(actual) && !Array.isArray(expected)) {
          if (!actual.includes(expected)) return false;
        }
        // Array includes check: if expected is an array, check if actual array contains all
        else if (Array.isArray(expected) && Array.isArray(actual)) {
          if (!expected.every(e => actual.includes(e))) return false;
        }
        // Direct equality
        else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          return false;
        }
      }
    }

    return true;
  });
}

/**
 * Build a prompt from a rule's template, interpolating {{dotted.path}} variables
 * with values from the event data.
 * Unmatched variables are left as-is (not replaced with empty string).
 */
export function buildPromptFromRule(rule: RuleDefinition, eventData: Record<string, unknown>): string {
  return rule.action.prompt_template.replace(
    /\{\{(\s*[\w.]+\s*)\}\}/g,
    (_match, pathStr: string) => {
      const trimmed = pathStr.trim();
      const parts = trimmed.split(".");
      let value: unknown = eventData;

      for (const part of parts) {
        if (value == null || typeof value !== "object") return _match; // leave as-is
        value = (value as Record<string, unknown>)[part];
      }

      if (value == null) return _match; // leave as-is
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    },
  );
}

/**
 * Match rules and build prompts for all matches.
 * Convenience function combining matchRules + buildPromptFromRule.
 */
export function evaluateRules(rules: RuleDefinition[], event: RuleEvent): MatchedRule[] {
  const matched = matchRules(rules, event);
  return matched.map(rule => ({
    ...rule,
    prompt: buildPromptFromRule(rule, event.data),
  }));
}
