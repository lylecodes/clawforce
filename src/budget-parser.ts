/**
 * Clawforce — Budget shorthand parser
 *
 * Parses "$20/day", "$5/hour", "$500/month" into BudgetConfig.
 */

import type { BudgetConfig } from "./types.js";

const SHORTHAND_RE = /^\$?([\d.]+)\s*\/\s*(hour|day|month)$/i;

export function parseBudgetShorthand(input: string): Partial<BudgetConfig> | null {
  if (!input || input.trim().length === 0) return null;

  const trimmed = input.trim();

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
