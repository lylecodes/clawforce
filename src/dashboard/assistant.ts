/**
 * Clawforce — Dashboard Assistant
 *
 * Auto-registers a dashboard assistant agent when the dashboard is active.
 * The assistant helps users operate their workforce via the chat widget.
 */

type DashboardAssistantConfig = {
  enabled: boolean;
  model?: string; // user's preferred model, read from OpenClaw config
  agentId?: string; // default: "clawforce-assistant"
};
