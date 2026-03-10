/**
 * Clawforce — Config Inheritance / Preset Resolution
 *
 * Walks `extends` chains, deep-merges configs, supports +/- array operators.
 */

function hasMergeOperators(arr: unknown[]): boolean {
  return arr.length > 0 && arr.every(
    (item) => typeof item === "string" && (item.startsWith("+") || item.startsWith("-")),
  );
}

export function mergeArrayWithOperators(
  parent: string[] | undefined,
  child: string[],
): string[] {
  if (!hasMergeOperators(child)) return child;

  const result = [...(parent ?? [])];
  for (const item of child) {
    if (item.startsWith("+")) {
      const value = item.slice(1);
      if (!result.includes(value)) result.push(value);
    } else if (item.startsWith("-")) {
      const value = item.slice(1);
      const idx = result.indexOf(value);
      if (idx !== -1) result.splice(idx, 1);
    }
  }
  return result;
}

function deepMerge(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const result = { ...parent };
  for (const key of Object.keys(child)) {
    const pVal = parent[key];
    const cVal = child[key];

    if (Array.isArray(cVal)) {
      result[key] = mergeArrayWithOperators(
        Array.isArray(pVal) ? (pVal as string[]) : undefined,
        cVal as string[],
      );
    } else if (
      cVal !== null &&
      typeof cVal === "object" &&
      !Array.isArray(cVal) &&
      pVal !== null &&
      typeof pVal === "object" &&
      !Array.isArray(pVal)
    ) {
      result[key] = deepMerge(
        pVal as Record<string, unknown>,
        cVal as Record<string, unknown>,
      );
    } else {
      result[key] = cVal;
    }
  }
  return result;
}

type PresetLookup = (name: string) => Record<string, unknown> | undefined;

export function detectCycle(
  startName: string,
  lookup: PresetLookup,
): string | null {
  const visited: string[] = [];
  let current: string | undefined = startName;
  while (current) {
    if (visited.includes(current)) {
      return [...visited, current].join(" → ");
    }
    visited.push(current);
    const preset = lookup(current);
    current = preset?.extends as string | undefined;
  }
  return null;
}

export function resolveConfig<T extends Record<string, unknown>>(
  config: T & { extends?: string },
  presets: Record<string, Record<string, unknown>>,
): T {
  if (!config.extends) {
    return { ...config };
  }

  const lookup: PresetLookup = (name) => presets[name];

  const cycle = detectCycle(config.extends, lookup);
  if (cycle) {
    throw new Error(`Circular extends chain detected: ${cycle}`);
  }

  const chain: Record<string, unknown>[] = [];
  let current: string | undefined = config.extends;
  while (current) {
    const preset = presets[current];
    if (!preset) {
      throw new Error(`Preset "${current}" not found`);
    }
    chain.unshift(preset);
    current = preset.extends as string | undefined;
  }

  let resolved: Record<string, unknown> = {};
  for (const layer of chain) {
    const { extends: _, ...rest } = layer;
    resolved = deepMerge(resolved, rest);
  }

  const { extends: __, ...childRest } = config;
  resolved = deepMerge(resolved, childRest);

  return resolved as T;
}
