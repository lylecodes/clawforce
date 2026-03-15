import { useState, useCallback } from "react";
import { useAppStore } from "../store";
import { useConfig } from "../hooks/useConfig";
import { BriefingBuilder } from "../components/BriefingBuilder";
import { CostPreview } from "../components/CostPreview";
import { ProfileSelector } from "../components/ProfileSelector";
import { BudgetSlider } from "../components/BudgetSlider";
import { InitiativeSliders } from "../components/InitiativeSliders";
import { YamlPreview } from "../components/YamlPreview";
import type {
  ConfigSection,
  AgentConfig,
  BudgetConfig,
  ToolGate,
  JobConfig,
  SafetyConfig,
} from "../api/types";

// ---------------------------------------------------------------------------
// Helpers — the backend may return richer object types for certain agent fields
// (e.g. expectations as { tool, action, min_calls } objects, briefing as
// { source, params, ... } objects). These helpers safely coerce values to the
// primitive types the UI components expect.
// ---------------------------------------------------------------------------

/** Safely convert a value to a displayable string (never returns an object). */
function safeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    // Expectation objects from backend: { tool, action, min_calls }
    const obj = value as Record<string, unknown>;
    if ("tool" in obj && typeof obj.tool === "string") {
      const action = Array.isArray(obj.action) ? obj.action.join(", ") : String(obj.action ?? "");
      return action ? `${obj.tool}: ${action}` : obj.tool;
    }
    // ContextSource objects from backend: { source, content?, path? }
    if ("source" in obj && typeof obj.source === "string") {
      return obj.source;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Normalize an array from the API into string[].
 * Handles arrays of objects (e.g. Expectation[]) by extracting a display string.
 */
function toStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map(safeString);
}

/**
 * Normalize a briefing array from the API into string[] of source names.
 * Backend sends ContextSource[] like [{ source: "pending_tasks" }, ...].
 */
function toBriefingStrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null && "source" in item) {
      return String((item as Record<string, unknown>).source ?? "");
    }
    return safeString(item);
  }).filter(Boolean);
}

/**
 * Normalize an AgentConfig from the API, coercing object fields to UI-safe types.
 */
function normalizeAgent(raw: AgentConfig): AgentConfig {
  return {
    ...raw,
    briefing: toBriefingStrings(raw.briefing) as string[],
    expectations: toStringArray(raw.expectations) as string[],
    performance_policy: raw.performance_policy && typeof raw.performance_policy === "object"
      ? {
          action: String((raw.performance_policy as Record<string, unknown>).action ?? "warn"),
          max_retries: Number((raw.performance_policy as Record<string, unknown>).max_retries ?? 3),
          then: String((raw.performance_policy as Record<string, unknown>).then ?? "escalate"),
        }
      : raw.performance_policy,
  };
}

const TABS: { id: ConfigSection; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "budget", label: "Budget" },
  { id: "tool_gates", label: "Tool Gates" },
  { id: "initiatives", label: "Initiatives" },
  { id: "jobs", label: "Jobs" },
  { id: "safety", label: "Safety" },
  { id: "profile", label: "Profile" },
  { id: "rules", label: "Rules" },
  { id: "event_handlers", label: "Event Handlers" },
  { id: "memory", label: "Memory" },
];

export function ConfigEditor() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const [activeTab, setActiveTab] = useState<ConfigSection>("agents");

  const {
    config,
    isLoading,
    dirtyKeys,
    markDirty,
    save,
    isSaving,
    preview,
    requestPreview,
    isPreviewLoading,
  } = useConfig();

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">No domain selected</p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to edit configuration.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <p className="text-cf-text-muted text-sm">Loading configuration...</p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-120px)] bg-cf-bg-primary rounded-lg border border-cf-border overflow-hidden">
      {/* Left sidebar: section tabs */}
      <div className="w-[200px] shrink-0 border-r border-cf-border bg-cf-bg-secondary flex flex-col">
        <div className="px-3 py-3 border-b border-cf-border-muted">
          <h3 className="text-xs font-semibold text-cf-text-primary">Configuration</h3>
          <p className="text-xxs text-cf-text-muted mt-0.5">{activeDomain}</p>
        </div>

        <nav className="flex-1 overflow-y-auto py-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between transition-colors ${
                activeTab === tab.id
                  ? "bg-cf-bg-tertiary text-cf-text-primary font-semibold"
                  : "text-cf-text-secondary hover:bg-cf-bg-tertiary/50 hover:text-cf-text-primary"
              }`}
            >
              <span>{tab.label}</span>
              {dirtyKeys.has(tab.id) && (
                <span className="w-1.5 h-1.5 rounded-full bg-cf-accent-orange" />
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Right panel: form editor */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "agents" && (
          <AgentsTab
            agents={config.agents}
            onSave={(data) => save("agents", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("agents")}
            isDirty={dirtyKeys.has("agents")}
            preview={preview}
            onPreview={(current, proposed) => requestPreview(current, proposed)}
            isPreviewLoading={isPreviewLoading}
          />
        )}
        {activeTab === "budget" && (
          <BudgetTab
            budget={config.budget}
            onSave={(data) => save("budget", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("budget")}
            isDirty={dirtyKeys.has("budget")}
            preview={preview}
            onPreview={(current, proposed) => requestPreview(current, proposed)}
            isPreviewLoading={isPreviewLoading}
          />
        )}
        {activeTab === "tool_gates" && (
          <ToolGatesTab
            gates={config.tool_gates}
            onSave={(data) => save("tool_gates", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("tool_gates")}
            isDirty={dirtyKeys.has("tool_gates")}
          />
        )}
        {activeTab === "initiatives" && (
          <InitiativesTab
            initiatives={config.initiatives}
            onSave={(data) => save("initiatives", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("initiatives")}
            isDirty={dirtyKeys.has("initiatives")}
          />
        )}
        {activeTab === "jobs" && (
          <JobsTab
            jobs={config.jobs}
            onSave={(data) => save("jobs", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("jobs")}
            isDirty={dirtyKeys.has("jobs")}
          />
        )}
        {activeTab === "safety" && (
          <SafetyTab
            safety={config.safety}
            onSave={(data) => save("safety", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("safety")}
            isDirty={dirtyKeys.has("safety")}
          />
        )}
        {activeTab === "profile" && (
          <GenericJsonTab
            label="Profile"
            data={config.profile}
            onSave={(data) => save("profile", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("profile")}
            isDirty={dirtyKeys.has("profile")}
          />
        )}
        {activeTab === "rules" && (
          <GenericJsonTab
            label="Rules"
            data={config.rules}
            onSave={(data) => save("rules", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("rules")}
            isDirty={dirtyKeys.has("rules")}
          />
        )}
        {activeTab === "event_handlers" && (
          <GenericJsonTab
            label="Event Handlers"
            data={config.event_handlers}
            onSave={(data) => save("event_handlers", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("event_handlers")}
            isDirty={dirtyKeys.has("event_handlers")}
          />
        )}
        {activeTab === "memory" && (
          <GenericJsonTab
            label="Memory"
            data={config.memory}
            onSave={(data) => save("memory", data)}
            isSaving={isSaving}
            markDirty={() => markDirty("memory")}
            isDirty={dirtyKeys.has("memory")}
          />
        )}
      </div>
    </div>
  );
}

// ================================================================
// Agents Tab
// ================================================================

type AgentsTabProps = {
  agents: AgentConfig[];
  onSave: (data: AgentConfig[]) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
  preview: ReturnType<typeof useConfig>["preview"];
  onPreview: (current: unknown, proposed: unknown) => void;
  isPreviewLoading: boolean;
};

function AgentsTab({
  agents,
  onSave,
  isSaving,
  markDirty,
  isDirty,
  preview,
  onPreview,
  isPreviewLoading,
}: AgentsTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    agents[0]?.id ?? null,
  );
  const [editState, setEditState] = useState<Record<string, AgentConfig>>(() => {
    const map: Record<string, AgentConfig> = {};
    for (const a of agents) map[a.id] = normalizeAgent(a);
    return map;
  });

  const selectedAgent = selectedId ? editState[selectedId] : null;

  const updateField = useCallback(
    (field: keyof AgentConfig, value: unknown) => {
      if (!selectedId) return;
      setEditState((prev) => ({
        ...prev,
        [selectedId]: { ...prev[selectedId], [field]: value },
      }));
      markDirty();
    },
    [selectedId, markDirty],
  );

  const handleSave = () => {
    onSave(Object.values(editState));
  };

  return (
    <div className="flex h-full">
      {/* Agent list */}
      <div className="w-[180px] shrink-0 border-r border-cf-border-muted bg-cf-bg-secondary overflow-y-auto">
        <div className="px-3 py-2 border-b border-cf-border-muted">
          <p className="text-xxs text-cf-text-muted font-semibold uppercase tracking-wider">
            Agents ({agents.length})
          </p>
        </div>
        {agents.map((agent) => (
          <button
            key={agent.id}
            onClick={() => setSelectedId(agent.id)}
            className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
              selectedId === agent.id
                ? "bg-cf-bg-tertiary text-cf-text-primary"
                : "text-cf-text-secondary hover:bg-cf-bg-tertiary/50"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                agent.reports_to
                  ? "bg-cf-accent-green"
                  : "bg-cf-accent-blue"
              }`}
            />
            <span className="truncate">{agent.id}</span>
          </button>
        ))}
      </div>

      {/* Agent editor */}
      <div className="flex-1 overflow-y-auto">
        {!selectedAgent ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-cf-text-muted text-sm">Select an agent to edit</p>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            <h2 className="text-sm font-semibold text-cf-text-primary">
              {selectedAgent.id}
            </h2>

            {/* Title */}
            <FormField label="Title">
              <input
                type="text"
                value={selectedAgent.title ?? ""}
                onChange={(e) => updateField("title", e.target.value)}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              />
            </FormField>

            {/* Persona */}
            <FormField label="Persona">
              <textarea
                value={selectedAgent.persona ?? ""}
                onChange={(e) => updateField("persona", e.target.value)}
                rows={3}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue resize-y"
              />
            </FormField>

            {/* Reports To */}
            <FormField label="Reports To">
              <select
                value={selectedAgent.reports_to ?? ""}
                onChange={(e) =>
                  updateField("reports_to", e.target.value || undefined)
                }
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              >
                <option value="">None (top-level)</option>
                {agents
                  .filter((a) => a.id !== selectedId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
              </select>
            </FormField>

            {/* Department + Team (row) */}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Department">
                <input
                  type="text"
                  value={selectedAgent.department ?? ""}
                  onChange={(e) => updateField("department", e.target.value)}
                  className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
                />
              </FormField>
              <FormField label="Team">
                <input
                  type="text"
                  value={selectedAgent.team ?? ""}
                  onChange={(e) => updateField("team", e.target.value)}
                  className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
                />
              </FormField>
            </div>

            {/* Channel */}
            <FormField label="Channel">
              <input
                type="text"
                value={selectedAgent.channel ?? ""}
                onChange={(e) => updateField("channel", e.target.value)}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              />
            </FormField>

            {/* Briefing builder */}
            <FormField label="Briefing Sources">
              <BriefingBuilder
                active={selectedAgent.briefing ?? []}
                available={[]}
                onChange={(active) => updateField("briefing", active)}
              />
            </FormField>

            {/* Expectations */}
            <FormField label="Expectations">
              <ExpectationsList
                items={selectedAgent.expectations ?? []}
                onChange={(items) => updateField("expectations", items)}
              />
            </FormField>

            {/* Performance policy */}
            <FormField label="Performance Policy">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xxs text-cf-text-muted block mb-1">
                    Action
                  </label>
                  <select
                    value={selectedAgent.performance_policy?.action ?? "warn"}
                    onChange={(e) =>
                      updateField("performance_policy", {
                        ...selectedAgent.performance_policy,
                        action: e.target.value,
                      })
                    }
                    className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
                  >
                    <option value="warn">Warn</option>
                    <option value="escalate">Escalate</option>
                    <option value="disable">Disable</option>
                  </select>
                </div>
                <div>
                  <label className="text-xxs text-cf-text-muted block mb-1">
                    Max Retries
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={selectedAgent.performance_policy?.max_retries ?? 3}
                    onChange={(e) =>
                      updateField("performance_policy", {
                        ...selectedAgent.performance_policy,
                        max_retries: Number(e.target.value),
                      })
                    }
                    className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
                  />
                </div>
                <div>
                  <label className="text-xxs text-cf-text-muted block mb-1">
                    Then
                  </label>
                  <select
                    value={selectedAgent.performance_policy?.then ?? "escalate"}
                    onChange={(e) =>
                      updateField("performance_policy", {
                        ...selectedAgent.performance_policy,
                        then: e.target.value,
                      })
                    }
                    className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
                  >
                    <option value="escalate">Escalate</option>
                    <option value="disable">Disable</option>
                    <option value="ignore">Ignore</option>
                  </select>
                </div>
              </div>
            </FormField>

            {/* YAML Preview */}
            <YamlPreview
              current={agents.find((a) => a.id === selectedId) ?? {}}
              proposed={selectedAgent}
              title="Agent Config Diff"
            />

            {/* Cost Preview */}
            <CostPreview preview={preview} isLoading={isPreviewLoading} />

            {/* Save button */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-cf-border-muted">
              {isDirty && (
                <span className="text-xxs text-cf-accent-orange">
                  Unsaved changes
                </span>
              )}
              <button
                onClick={() =>
                  onPreview(
                    agents.find((a) => a.id === selectedId),
                    selectedAgent,
                  )
                }
                className="px-3 py-1.5 text-xs text-cf-text-secondary hover:text-cf-text-primary border border-cf-border rounded hover:bg-cf-bg-tertiary transition-colors"
              >
                Preview Impact
              </button>
              <button
                onClick={handleSave}
                disabled={!isDirty || isSaving}
                className="px-4 py-1.5 bg-cf-accent-blue text-white text-xs font-semibold rounded hover:bg-cf-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? "Saving..." : "Save & Apply"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ================================================================
// Budget Tab
// ================================================================

type BudgetTabProps = {
  budget: BudgetConfig;
  onSave: (data: BudgetConfig) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
  preview: ReturnType<typeof useConfig>["preview"];
  onPreview: (current: unknown, proposed: unknown) => void;
  isPreviewLoading: boolean;
};

function BudgetTab({
  budget,
  onSave,
  isSaving,
  markDirty,
  isDirty,
  preview,
  onPreview,
  isPreviewLoading,
}: BudgetTabProps) {
  const [editBudget, setEditBudget] = useState<BudgetConfig>({ ...budget });

  const update = useCallback(
    (partial: Partial<BudgetConfig>) => {
      setEditBudget((prev) => ({ ...prev, ...partial }));
      markDirty();
    },
    [markDirty],
  );

  const updateWindow = useCallback(
    (
      window: "daily" | "hourly" | "monthly",
      field: "cents" | "tokens" | "requests",
      value: number,
    ) => {
      setEditBudget((prev) => ({
        ...prev,
        [window]: { ...prev[window], [field]: value },
      }));
      markDirty();
    },
    [markDirty],
  );

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-sm font-semibold text-cf-text-primary">
        Budget Configuration
      </h2>

      {/* Operational Profile */}
      <FormField label="Operational Profile">
        <ProfileSelector
          selected={editBudget.operational_profile ?? "medium"}
          onSelect={(id) => update({ operational_profile: id })}
        />
      </FormField>

      {/* Daily limits */}
      <FormField label="Daily Limits">
        <div className="space-y-3">
          <BudgetSlider
            label="Cost (cents)"
            value={editBudget.daily?.cents ?? 500}
            max={10000}
            step={50}
            unit="$"
            onChange={(v) => updateWindow("daily", "cents", v)}
          />
          <BudgetSlider
            label="Tokens"
            value={editBudget.daily?.tokens ?? 100000}
            max={1000000}
            step={10000}
            unit="tokens"
            onChange={(v) => updateWindow("daily", "tokens", v)}
          />
          <BudgetSlider
            label="Requests"
            value={editBudget.daily?.requests ?? 100}
            max={1000}
            step={10}
            unit="req"
            onChange={(v) => updateWindow("daily", "requests", v)}
          />
        </div>
      </FormField>

      {/* Hourly + Monthly (compact) */}
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Hourly Limits">
          <div className="space-y-2">
            <CompactInput
              label="Cents"
              value={editBudget.hourly?.cents ?? 100}
              onChange={(v) => updateWindow("hourly", "cents", v)}
            />
            <CompactInput
              label="Tokens"
              value={editBudget.hourly?.tokens ?? 20000}
              onChange={(v) => updateWindow("hourly", "tokens", v)}
            />
            <CompactInput
              label="Requests"
              value={editBudget.hourly?.requests ?? 20}
              onChange={(v) => updateWindow("hourly", "requests", v)}
            />
          </div>
        </FormField>

        <FormField label="Monthly Limits">
          <div className="space-y-2">
            <CompactInput
              label="Cents"
              value={editBudget.monthly?.cents ?? 15000}
              onChange={(v) => updateWindow("monthly", "cents", v)}
            />
            <CompactInput
              label="Tokens"
              value={editBudget.monthly?.tokens ?? 3000000}
              onChange={(v) => updateWindow("monthly", "tokens", v)}
            />
            <CompactInput
              label="Requests"
              value={editBudget.monthly?.requests ?? 3000}
              onChange={(v) => updateWindow("monthly", "requests", v)}
            />
          </div>
        </FormField>
      </div>

      {/* Initiative allocation */}
      <FormField label="Initiative Allocation">
        <InitiativeSliders
          initiatives={editBudget.initiatives ?? {}}
          onChange={(initiatives) => update({ initiatives })}
        />
      </FormField>

      {/* Cost preview */}
      <CostPreview preview={preview} isLoading={isPreviewLoading} />

      {/* Save */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-cf-border-muted">
        {isDirty && (
          <span className="text-xxs text-cf-accent-orange">Unsaved changes</span>
        )}
        <button
          onClick={() => onPreview(budget, editBudget)}
          className="px-3 py-1.5 text-xs text-cf-text-secondary hover:text-cf-text-primary border border-cf-border rounded hover:bg-cf-bg-tertiary transition-colors"
        >
          Preview Impact
        </button>
        <button
          onClick={() => onSave(editBudget)}
          disabled={!isDirty || isSaving}
          className="px-4 py-1.5 bg-cf-accent-blue text-white text-xs font-semibold rounded hover:bg-cf-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? "Saving..." : "Save & Apply"}
        </button>
      </div>
    </div>
  );
}

// ================================================================
// Tool Gates Tab
// ================================================================

function ToolGatesTab({
  gates,
  onSave,
  isSaving,
  markDirty,
  isDirty,
}: {
  gates: ToolGate[];
  onSave: (data: ToolGate[]) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
}) {
  const [editGates, setEditGates] = useState<ToolGate[]>([...gates]);

  const TIERS: ToolGate["risk_tier"][] = ["low", "medium", "high", "critical"];
  const TIER_STYLES: Record<string, string> = {
    low: "bg-cf-risk-low/15 text-cf-risk-low",
    medium: "bg-cf-risk-medium/15 text-cf-risk-medium",
    high: "bg-cf-risk-high/15 text-cf-risk-high",
    critical: "bg-cf-accent-red/30 text-cf-accent-red",
  };

  // Group by category
  const grouped = new Map<string, ToolGate[]>();
  for (const gate of editGates) {
    const cat = gate.category ?? "Uncategorized";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(gate);
  }

  const cycleTier = (tool: string) => {
    setEditGates((prev) =>
      prev.map((g) => {
        if (g.tool !== tool) return g;
        const idx = TIERS.indexOf(g.risk_tier);
        return { ...g, risk_tier: TIERS[(idx + 1) % TIERS.length] };
      }),
    );
    markDirty();
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-cf-text-primary">Tool Gates</h2>
      <p className="text-xxs text-cf-text-muted">
        Click a tier badge to cycle through risk levels. Higher tiers require more approval.
      </p>

      {Array.from(grouped.entries()).map(([category, categoryGates]) => (
        <div key={category}>
          <h3 className="text-xxs text-cf-text-muted font-semibold uppercase tracking-wider mb-2">
            {category}
          </h3>
          <div className="grid grid-cols-1 gap-1">
            {categoryGates.map((gate) => (
              <div
                key={gate.tool}
                className="flex items-center justify-between bg-cf-bg-secondary border border-cf-border rounded px-3 py-2"
              >
                <span className="text-xs text-cf-text-primary font-mono">
                  {gate.tool}
                </span>
                <button
                  onClick={() => cycleTier(gate.tool)}
                  className={`text-xxs px-2 py-0.5 rounded font-bold ${TIER_STYLES[gate.risk_tier]}`}
                >
                  {gate.risk_tier.toUpperCase()}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {editGates.length === 0 && (
        <p className="text-cf-text-muted text-xs text-center py-4">
          No tool gates configured.
        </p>
      )}

      <SaveFooter
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={() => onSave(editGates)}
      />
    </div>
  );
}

// ================================================================
// Initiatives Tab
// ================================================================

function InitiativesTab({
  initiatives,
  onSave,
  isSaving,
  markDirty,
  isDirty,
}: {
  initiatives: Record<string, { allocation_pct: number; goal?: string }>;
  onSave: (data: Record<string, { allocation_pct: number; goal?: string }>) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
}) {
  const [editData, setEditData] = useState({ ...initiatives });
  const [newName, setNewName] = useState("");

  const handleAllocationChange = (key: string, value: number) => {
    setEditData((prev) => ({
      ...prev,
      [key]: { ...prev[key], allocation_pct: value },
    }));
    markDirty();
  };

  const handleGoalChange = (key: string, goal: string) => {
    setEditData((prev) => ({
      ...prev,
      [key]: { ...prev[key], goal: goal || undefined },
    }));
    markDirty();
  };

  const handleAdd = () => {
    const name = newName.trim();
    if (!name || editData[name]) return;
    setEditData((prev) => ({
      ...prev,
      [name]: { allocation_pct: 0 },
    }));
    setNewName("");
    markDirty();
  };

  const handleRemove = (key: string) => {
    setEditData((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    markDirty();
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-cf-text-primary">Initiatives</h2>

      {Object.entries(editData).map(([key, value]) => (
        <div
          key={key}
          className="bg-cf-bg-secondary border border-cf-border rounded-lg p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-cf-text-primary font-semibold">{key}</span>
            <button
              onClick={() => handleRemove(key)}
              className="text-xxs text-cf-accent-red hover:underline"
            >
              Remove
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xxs text-cf-text-muted block mb-1">
                Allocation (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={value.allocation_pct}
                onChange={(e) => handleAllocationChange(key, Number(e.target.value))}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              />
            </div>
            <div>
              <label className="text-xxs text-cf-text-muted block mb-1">
                Goal ID (optional)
              </label>
              <input
                type="text"
                value={value.goal ?? ""}
                onChange={(e) => handleGoalChange(key, e.target.value)}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              />
            </div>
          </div>
        </div>
      ))}

      {/* Add new */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New initiative name"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          className="flex-1 bg-cf-bg-tertiary border border-cf-border rounded px-3 py-1.5 text-xs text-cf-text-primary placeholder:text-cf-text-muted focus:outline-none focus:border-cf-accent-blue"
        />
        <button
          onClick={handleAdd}
          disabled={!newName.trim()}
          className="px-3 py-1.5 bg-cf-accent-blue text-white text-xxs font-semibold rounded disabled:opacity-40 transition-colors"
        >
          Add
        </button>
      </div>

      <SaveFooter
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={() => onSave(editData)}
      />
    </div>
  );
}

// ================================================================
// Jobs Tab
// ================================================================

function JobsTab({
  jobs,
  onSave,
  isSaving,
  markDirty,
  isDirty,
}: {
  jobs: JobConfig[];
  onSave: (data: JobConfig[]) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
}) {
  const [editJobs, setEditJobs] = useState<JobConfig[]>([...jobs]);

  const updateJob = (index: number, partial: Partial<JobConfig>) => {
    setEditJobs((prev) =>
      prev.map((j, i) => (i === index ? { ...j, ...partial } : j)),
    );
    markDirty();
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-cf-text-primary">Scheduled Jobs</h2>

      {editJobs.map((job, i) => (
        <div
          key={job.id}
          className="bg-cf-bg-secondary border border-cf-border rounded-lg p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-cf-text-primary font-mono font-semibold">
              {job.id}
            </span>
            <button
              onClick={() => updateJob(i, { enabled: !job.enabled })}
              className={`text-xxs px-2 py-0.5 rounded font-bold transition-colors ${
                job.enabled
                  ? "bg-cf-accent-green/15 text-cf-accent-green"
                  : "bg-cf-bg-tertiary text-cf-text-muted"
              }`}
            >
              {job.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xxs text-cf-text-muted block mb-1">Agent</label>
              <input
                type="text"
                value={job.agent}
                onChange={(e) => updateJob(i, { agent: e.target.value })}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              />
            </div>
            <div>
              <label className="text-xxs text-cf-text-muted block mb-1">Cron</label>
              <input
                type="text"
                value={job.cron}
                onChange={(e) => updateJob(i, { cron: e.target.value })}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary font-mono focus:outline-none focus:border-cf-accent-blue"
              />
            </div>
            <div>
              <label className="text-xxs text-cf-text-muted block mb-1">
                Description
              </label>
              <input
                type="text"
                value={job.description ?? ""}
                onChange={(e) => updateJob(i, { description: e.target.value })}
                className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary focus:outline-none focus:border-cf-accent-blue"
              />
            </div>
          </div>
        </div>
      ))}

      {editJobs.length === 0 && (
        <p className="text-cf-text-muted text-xs text-center py-4">
          No jobs configured.
        </p>
      )}

      <SaveFooter
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={() => onSave(editJobs)}
      />
    </div>
  );
}

// ================================================================
// Safety Tab
// ================================================================

function SafetyTab({
  safety,
  onSave,
  isSaving,
  markDirty,
  isDirty,
}: {
  safety: SafetyConfig;
  onSave: (data: SafetyConfig) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
}) {
  // Defensive: ensure safety values are numbers (API may return unexpected types)
  const [editSafety, setEditSafety] = useState<SafetyConfig>(() => ({
    circuit_breaker_multiplier: typeof safety.circuit_breaker_multiplier === "number"
      ? safety.circuit_breaker_multiplier : undefined,
    spawn_depth_limit: typeof safety.spawn_depth_limit === "number"
      ? safety.spawn_depth_limit : undefined,
    loop_detection_threshold: typeof safety.loop_detection_threshold === "number"
      ? safety.loop_detection_threshold : undefined,
  }));

  const update = (partial: Partial<SafetyConfig>) => {
    setEditSafety((prev) => ({ ...prev, ...partial }));
    markDirty();
  };

  const DEFAULTS = {
    circuit_breaker_multiplier: 3,
    spawn_depth_limit: 5,
    loop_detection_threshold: 10,
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-cf-text-primary">Safety Settings</h2>
      <p className="text-xxs text-cf-text-muted">
        These settings control agent safety guardrails. Lower values are more restrictive.
      </p>

      <SafetySlider
        label="Circuit Breaker Multiplier"
        description="How many times the cost threshold can be exceeded before tripping. Lower = stricter."
        value={editSafety.circuit_breaker_multiplier ?? DEFAULTS.circuit_breaker_multiplier}
        defaultValue={DEFAULTS.circuit_breaker_multiplier}
        min={1}
        max={10}
        step={0.5}
        onChange={(v) => update({ circuit_breaker_multiplier: v })}
      />

      <SafetySlider
        label="Spawn Depth Limit"
        description="Maximum depth of agent spawn chains. Prevents runaway recursive spawning."
        value={editSafety.spawn_depth_limit ?? DEFAULTS.spawn_depth_limit}
        defaultValue={DEFAULTS.spawn_depth_limit}
        min={1}
        max={20}
        step={1}
        onChange={(v) => update({ spawn_depth_limit: v })}
      />

      <SafetySlider
        label="Loop Detection Threshold"
        description="Number of repeated similar actions before flagging a loop. Lower = more sensitive."
        value={editSafety.loop_detection_threshold ?? DEFAULTS.loop_detection_threshold}
        defaultValue={DEFAULTS.loop_detection_threshold}
        min={3}
        max={50}
        step={1}
        onChange={(v) => update({ loop_detection_threshold: v })}
      />

      <SaveFooter
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={() => onSave(editSafety)}
      />
    </div>
  );
}

function SafetySlider({
  label,
  description,
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-cf-text-primary font-semibold">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xxs text-cf-text-muted">
            Default: {defaultValue}
          </span>
          <span className="text-sm text-cf-text-primary font-bold font-mono">
            {value}
          </span>
        </div>
      </div>
      <p className="text-xxs text-cf-text-muted">{description}</p>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-cf-bg-tertiary
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-3.5
          [&::-webkit-slider-thumb]:h-3.5
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-cf-accent-blue
          [&::-webkit-slider-thumb]:border-2
          [&::-webkit-slider-thumb]:border-cf-bg-secondary
          [&::-webkit-slider-thumb]:cursor-grab
        "
      />
      <div className="flex justify-between text-xxs text-cf-text-muted font-mono">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

// ================================================================
// Generic JSON Tab (for Profile, Rules, Event Handlers, Memory)
// ================================================================

function GenericJsonTab({
  label,
  data,
  onSave,
  isSaving,
  markDirty,
  isDirty,
}: {
  label: string;
  data: unknown;
  onSave: (data: unknown) => void;
  isSaving: boolean;
  markDirty: () => void;
  isDirty: boolean;
}) {
  const [jsonText, setJsonText] = useState(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return "{}";
    }
  });
  const [parseError, setParseError] = useState<string | null>(null);

  const handleChange = (value: string) => {
    setJsonText(value);
    markDirty();
    try {
      JSON.parse(value);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const handleSave = () => {
    try {
      const parsed = JSON.parse(jsonText);
      onSave(parsed);
    } catch {
      // parse error, don't save
    }
  };

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-sm font-semibold text-cf-text-primary">{label}</h2>
      <p className="text-xxs text-cf-text-muted">
        Edit the raw JSON configuration for {label.toLowerCase()}.
      </p>

      <textarea
        value={jsonText}
        onChange={(e) => handleChange(e.target.value)}
        rows={20}
        spellCheck={false}
        className={`w-full bg-cf-bg-tertiary border rounded px-3 py-2 text-xs text-cf-text-primary font-mono focus:outline-none resize-y ${
          parseError
            ? "border-cf-accent-red focus:border-cf-accent-red"
            : "border-cf-border focus:border-cf-accent-blue"
        }`}
      />

      {parseError && (
        <p className="text-xxs text-cf-accent-red">{parseError}</p>
      )}

      <SaveFooter
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        disabled={!!parseError}
      />
    </div>
  );
}

// ================================================================
// Shared Components
// ================================================================

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xxs text-cf-text-secondary font-semibold uppercase tracking-wider block mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function ExpectationsList({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const [newItem, setNewItem] = useState("");

  // Defensive: ensure all items are strings (API may return objects)
  const safeItems = items.map((item) =>
    typeof item === "string" ? item : safeString(item),
  );

  const handleAdd = () => {
    const trimmed = newItem.trim();
    if (!trimmed) return;
    onChange([...safeItems, trimmed]);
    setNewItem("");
  };

  const handleRemove = (index: number) => {
    onChange(safeItems.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-1.5">
      {safeItems.map((item, i) => (
        <div
          key={i}
          className="flex items-center gap-2 bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5"
        >
          <span className="text-xxs text-cf-text-primary flex-1">{item}</span>
          <button
            onClick={() => handleRemove(i)}
            className="text-xxs text-cf-accent-red hover:underline shrink-0"
          >
            remove
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="Add expectation..."
          className="flex-1 bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-xxs text-cf-text-primary placeholder:text-cf-text-muted focus:outline-none focus:border-cf-accent-blue"
        />
        <button
          onClick={handleAdd}
          disabled={!newItem.trim()}
          className="text-xxs text-cf-accent-blue hover:underline disabled:opacity-40"
        >
          add
        </button>
      </div>
    </div>
  );
}

function CompactInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xxs text-cf-text-muted w-16">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1 text-xxs text-cf-text-primary font-mono focus:outline-none focus:border-cf-accent-blue"
      />
    </div>
  );
}

function SaveFooter({
  isDirty,
  isSaving,
  onSave,
  disabled,
}: {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2 border-t border-cf-border-muted">
      {isDirty && (
        <span className="text-xxs text-cf-accent-orange">Unsaved changes</span>
      )}
      <button
        onClick={onSave}
        disabled={!isDirty || isSaving || disabled}
        className="px-4 py-1.5 bg-cf-accent-blue text-white text-xs font-semibold rounded hover:bg-cf-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isSaving ? "Saving..." : "Save & Apply"}
      </button>
    </div>
  );
}

export default ConfigEditor;
