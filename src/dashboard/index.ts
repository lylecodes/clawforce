/**
 * Clawforce — Dashboard barrel export
 */

export { createDashboardServer } from "./server.js";
export type { DashboardOptions } from "./server.js";
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
