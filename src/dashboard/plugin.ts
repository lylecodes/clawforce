import type { Clawforce } from "../sdk/index.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
}

/**
 * Start the Clawforce dashboard as a plugin.
 * Consumes a Clawforce SDK instance and serves the React dashboard.
 *
 * @example
 * ```typescript
 * import { Clawforce } from "clawforce";
 * import { serveDashboard } from "clawforce/dashboard";
 *
 * const cf = Clawforce.init({ domain: "my-project" });
 * serveDashboard(cf, { port: 5173 });
 * ```
 */
export function serveDashboard(cf: Clawforce, opts?: DashboardOptions): void {
  const _port = opts?.port ?? 3117;
  const _host = opts?.host ?? "localhost";

  // This is a thin wrapper establishing the plugin interface.
  // Full implementation will wire the existing dashboard server
  // to use the SDK instance instead of direct internal imports.
  // For now, it validates the pattern and documents the contract.
  console.log(`[clawforce-dashboard] Ready to serve dashboard for domain "${cf.domain}" on ${_host}:${_port}`);
  console.log(`[clawforce-dashboard] Full implementation pending — use existing gateway routes for now`);
}
