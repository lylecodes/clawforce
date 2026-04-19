/**
 * clawforce — Source compatibility shim
 *
 * The explicit internal contract now lives in `src/internal.ts`.
 * Keep this file as a local shim so source-level imports do not break while
 * the package export surface maps `clawforce/internal` to `internal.ts`.
 */

export * from "./internal.js";
