import type { Clawforce } from "../sdk/index.js";
import { createDashboardServer } from "./server.js";
import { safeLog } from "../diagnostics.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
  /**
   * Absolute path to the dashboard dist directory containing the built SPA.
   * Defaults to `../clawforce-dashboard/dist` (sibling project).
   * Override to point at a custom dashboard build output.
   */
  dashboardDir?: string;
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
  const port = opts?.port
    ?? (process.env.CLAWFORCE_DASHBOARD_PORT ? Number(process.env.CLAWFORCE_DASHBOARD_PORT) : 3117);
  const host = opts?.host
    ?? process.env.CLAWFORCE_DASHBOARD_HOST
    ?? "localhost";
  const dashboardDir = opts?.dashboardDir;

  const dashboard = createDashboardServer({
    port,
    host,
    dashboardDir,
  });

  void dashboard.start()
    .then(() => {
      console.log(`[clawforce-dashboard] Serving dashboard for domain "${cf.domain}" at http://${host}:${port}/clawforce/`);
    })
    .catch((err) => {
      safeLog("dashboard.plugin", err);
    });
}
