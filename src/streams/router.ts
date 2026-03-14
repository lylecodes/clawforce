/**
 * Clawforce — Multi-Output Stream Router
 *
 * Evaluates routing rules: condition check -> fan out to output adapters.
 */

import { evaluateCondition } from "./conditions.js";
import { safeLog } from "../diagnostics.js";
import type { OutputTarget } from "./catalog.js";

export type RouteOutput = {
  target: OutputTarget;
  channel?: string;
  url?: string;
};

export type RouteDefinition = {
  name: string;
  source: string;
  params?: Record<string, unknown>;
  condition?: string;
  schedule?: string;
  streamName?: string;
  outputs: RouteOutput[];
};

export type RouteEvalResult = {
  name: string;
  matched: boolean;
  outputs: RouteOutput[];
};

export type DeliveryResult = {
  target: OutputTarget;
  delivered: boolean;
  error?: string;
};

export function evaluateRoute(
  route: RouteDefinition,
  streamData: Record<string, unknown>,
): RouteEvalResult {
  if (route.condition) {
    const matched = evaluateCondition(route.condition, streamData);
    return { name: route.name, matched, outputs: matched ? route.outputs : [] };
  }

  // No condition = always match
  return { name: route.name, matched: true, outputs: route.outputs };
}

export async function deliverToOutput(
  output: RouteOutput,
  routeName: string,
  content: string,
  projectId: string,
): Promise<DeliveryResult> {
  switch (output.target) {
    case "log": {
      safeLog("stream-router", `[${routeName}] ${content.slice(0, 200)}`);
      return { target: "log", delivered: true };
    }

    case "webhook": {
      if (!output.url) {
        return { target: "webhook", delivered: false, error: "No URL specified" };
      }
      try {
        const resp = await fetch(output.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route: routeName, project: projectId, content }),
          signal: AbortSignal.timeout(10000),
        });
        return {
          target: "webhook",
          delivered: resp.ok,
          error: resp.ok ? undefined : `HTTP ${resp.status}`,
        };
      } catch (err) {
        return {
          target: "webhook",
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "telegram": {
      try {
        const { getApprovalNotifier } = await import("../approval/notify.js");
        const notifier = getApprovalNotifier();
        if (!notifier) {
          safeLog("stream-router", `[${routeName}] Telegram not configured, falling back to log`);
          safeLog("stream-router", `[${routeName}] ${content.slice(0, 200)}`);
          return { target: "telegram", delivered: true };
        }
        // Use sendProposalNotification with a synthetic payload
        // (ApprovalNotifier interface only has sendProposalNotification and editProposalMessage)
        await notifier.sendProposalNotification({
          proposalId: `stream-${routeName}-${Date.now()}`,
          projectId,
          title: `Stream: ${routeName}`,
          proposedBy: "system",
          description: content.slice(0, 500),
        });
        return { target: "telegram", delivered: true };
      } catch (err) {
        return {
          target: "telegram",
          delivered: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case "briefing": {
      // Briefing delivery is handled by the assembler at context build time
      // This adapter is a no-op — the route config tells the assembler to include it
      return { target: "briefing", delivered: true };
    }

    default:
      return { target: output.target, delivered: false, error: "Unknown target" };
  }
}

export async function executeRoute(
  route: RouteDefinition,
  streamData: Record<string, unknown>,
  content: string,
  projectId: string,
): Promise<{ route: string; results: DeliveryResult[] }> {
  const evalResult = evaluateRoute(route, streamData);
  if (!evalResult.matched) {
    return { route: route.name, results: [] };
  }

  const results: DeliveryResult[] = [];
  for (const output of evalResult.outputs) {
    const result = await deliverToOutput(output, route.name, content, projectId);
    results.push(result);
  }

  return { route: route.name, results };
}
