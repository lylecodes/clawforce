/**
 * TypeBox schema helpers — ported from OpenClaw core.
 *
 * stringEnum avoids Type.Union([Type.Literal(...)]) which some validators
 * reject (no anyOf/oneOf in tool schemas).
 */

import { Type } from "@sinclair/typebox";
import type { SchemaOptions, TUnsafe } from "@sinclair/typebox";

export function stringEnum<T extends readonly string[]>(
  values: T,
  options?: SchemaOptions,
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

