/**
 * Clawforce — Dashboard barrel export
 */

export { createDashboardServer } from "./server.js";
export type { DashboardOptions } from "./server.js";
export {
  registerDashboardExtension,
  unregisterDashboardExtension,
  listDashboardExtensions,
  getDashboardExtension,
  clearDashboardExtensions,
} from "./extensions.js";
export type {
  DashboardExtensionContribution,
  DashboardExtensionSource,
  DashboardExtensionSurface,
  DashboardExtensionPage,
  DashboardExtensionPanel,
  DashboardExtensionAction,
  DashboardExtensionConfigSection,
} from "./extensions.js";
export { handleRequest } from "./routes.js";
export type { RouteResult } from "./routes.js";
export {
  queryProjects,
  queryAgents,
  queryAgentDetail,
  queryTasks,
  queryTaskDetail,
  querySessions,
  queryEvents,
  queryMetricsDashboard,
  queryCosts,
  queryPolicies,
  querySlos,
  queryAlerts,
  queryOrgChart,
  queryHealth,
  queryDashboardSummary,
  queryApprovals,
  queryBudgetStatus,
  queryBudgetForecast,
  queryTrustScores,
  queryConfig,
  queryMeetings,
  queryMeetingDetail,
} from "./queries.js";
export { SSEManager, getSSEManager, emitSSE } from "./sse.js";
export type { SSEEventType } from "./sse.js";
export { handleAction } from "./actions.js";
export { createDashboardHandler } from "./gateway-routes.js";
export type { DashboardHandlerOptions } from "./gateway-routes.js";
export { checkAuth, setCorsHeaders, checkRateLimit, resetRateLimits, isLocalhost } from "./auth.js";
export type { AuthOptions } from "./auth.js";
