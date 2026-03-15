import { AgentNode } from "./AgentNode";
import type { OrgAgent } from "../api/types";

type OrgTreeProps = {
  agents: OrgAgent[];
  statusMap: Record<string, "active" | "idle" | "disabled" | "warning">;
  trustMap: Record<string, number>;
  spendMap: Record<string, number>;
  selectedAgentId: string | null;
  onSelectAgent: (agent: OrgAgent) => void;
  onDoubleClickAgent?: (agent: OrgAgent) => void;
};

/** Build a map of parentId -> children from the flat agent list */
function buildTree(agents: OrgAgent[]): Map<string | null, OrgAgent[]> {
  const tree = new Map<string | null, OrgAgent[]>();
  for (const agent of agents) {
    const parentKey = agent.reportsTo ?? null;
    const children = tree.get(parentKey) ?? [];
    children.push(agent);
    tree.set(parentKey, children);
  }
  return tree;
}

export function OrgTree({
  agents,
  statusMap,
  trustMap,
  spendMap,
  selectedAgentId,
  onSelectAgent,
  onDoubleClickAgent,
}: OrgTreeProps) {
  const tree = buildTree(agents);
  const roots = tree.get(null) ?? [];

  // Also find agents whose reportsTo references an agent not in the list
  const agentIds = new Set(agents.map((a) => a.id));
  for (const agent of agents) {
    if (agent.reportsTo && !agentIds.has(agent.reportsTo)) {
      // Orphaned reference -- treat as root
      if (!roots.includes(agent)) {
        roots.push(agent);
      }
    }
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[300px]">
        <p className="text-cf-text-muted text-sm">No agents in org chart</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto overflow-y-auto pb-8">
      <div className="inline-flex flex-col items-center min-w-full">
        {roots.length === 1 ? (
          <TreeNode
            agent={roots[0]}
            tree={tree}
            statusMap={statusMap}
            trustMap={trustMap}
            spendMap={spendMap}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
            onDoubleClickAgent={onDoubleClickAgent}
          />
        ) : (
          <div className="flex gap-8 justify-center">
            {roots.map((root) => (
              <TreeNode
                key={root.id}
                agent={root}
                tree={tree}
                statusMap={statusMap}
                trustMap={trustMap}
                spendMap={spendMap}
                selectedAgentId={selectedAgentId}
                onSelectAgent={onSelectAgent}
                onDoubleClickAgent={onDoubleClickAgent}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type TreeNodeProps = {
  agent: OrgAgent;
  tree: Map<string | null, OrgAgent[]>;
  statusMap: Record<string, "active" | "idle" | "disabled" | "warning">;
  trustMap: Record<string, number>;
  spendMap: Record<string, number>;
  selectedAgentId: string | null;
  onSelectAgent: (agent: OrgAgent) => void;
  onDoubleClickAgent?: (agent: OrgAgent) => void;
};

function TreeNode({
  agent,
  tree,
  statusMap,
  trustMap,
  spendMap,
  selectedAgentId,
  onSelectAgent,
  onDoubleClickAgent,
}: TreeNodeProps) {
  const children = tree.get(agent.id) ?? [];

  return (
    <div className="flex flex-col items-center">
      {/* This agent's node */}
      <AgentNode
        agent={agent}
        status={statusMap[agent.id] ?? "idle"}
        trustScore={trustMap[agent.id] ?? 0}
        spendCents={spendMap[agent.id] ?? 0}
        isSelected={selectedAgentId === agent.id}
        onClick={() => onSelectAgent(agent)}
        onDoubleClick={() => onDoubleClickAgent?.(agent)}
      />

      {/* Connector lines + children */}
      {children.length > 0 && (
        <>
          {/* Vertical line down from parent */}
          <div className="w-px h-6 bg-cf-border" />

          {/* Horizontal connector spanning children */}
          {children.length > 1 && (
            <div className="relative w-full flex justify-center">
              <div
                className="h-px bg-cf-border absolute top-0"
                style={{
                  left: `${100 / (children.length * 2)}%`,
                  right: `${100 / (children.length * 2)}%`,
                }}
              />
            </div>
          )}

          {/* Children row */}
          <div className="flex gap-6 justify-center">
            {children.map((child) => (
              <div key={child.id} className="flex flex-col items-center">
                {/* Vertical line down to child */}
                <div className="w-px h-6 bg-cf-border" />

                <TreeNode
                  agent={child}
                  tree={tree}
                  statusMap={statusMap}
                  trustMap={trustMap}
                  spendMap={spendMap}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={onSelectAgent}
                  onDoubleClickAgent={onDoubleClickAgent}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
