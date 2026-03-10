/**
 * Clawforce — Budget shorthand parser
 *
 * Parses "$20/day", "$5/hour", "$500/month" into BudgetConfig.
 */

import type { BudgetConfig } from "./types.js";

const SHORTHAND_RE = /^\$?([\d.]+)\s*\/\s*(hour|day|month)$/i;

function parseSingleWindow(segment: string): Partial<BudgetConfig> | null {
  const trimmed = segment.trim();

  // Numeric-only: treat as daily limit in cents
  if (/^\d+$/.test(trimmed)) {
    return { dailyLimitCents: parseInt(trimmed, 10) };
  }

  const match = trimmed.match(SHORTHAND_RE);
  if (!match) return null;

  const dollars = parseFloat(match[1]);
  const cents = Math.round(dollars * 100);
  const window = match[2].toLowerCase();

  switch (window) {
    case "hour":
      return { hourlyLimitCents: cents };
    case "day":
      return { dailyLimitCents: cents };
    case "month":
      return { monthlyLimitCents: cents };
    default:
      return null;
  }
}

/**
 * Parse budget shorthand string(s) into BudgetConfig.
 * Supports single ("$20/day") or combined ("$5/hour + $100/day + $500/month").
 */
export function parseBudgetShorthand(input: string): Partial<BudgetConfig> | null {
  if (!input || input.trim().length === 0) return null;

  const segments = input.split("+");
  const result: Partial<BudgetConfig> = {};
  let matched = false;

  for (const seg of segments) {
    const parsed = parseSingleWindow(seg);
    if (parsed) {
      Object.assign(result, parsed);
      matched = true;
    }
  }

  return matched ? result : null;
}
