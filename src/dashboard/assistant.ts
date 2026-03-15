/**
 * Clawforce — Dashboard Assistant
 *
 * Auto-registers a dashboard assistant agent when the dashboard is active.
 * The assistant helps users operate their workforce via the chat widget.
 */

export type DashboardAssistantConfig = {
  enabled: boolean;
  model?: string; // user's preferred model, read from OpenClaw config
  agentId?: string; // default: "clawforce-assistant"
};

export function getAssistantAgentId(config?: DashboardAssistantConfig): string {
  return config?.agentId ?? "clawforce-assistant";
}

export function shouldEnableAssistant(config?: DashboardAssistantConfig): boolean {
  return config?.enabled !== false; // enabled by default
}
