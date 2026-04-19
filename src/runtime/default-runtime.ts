import type { DatabaseSync } from "../sqlite-driver.js";
import type { FSWatcher } from "node:fs";
import path from "node:path";
import { getClawforceHome } from "../paths.js";
import type {
  OpenClawSessionState,
  RuntimeIntegrationState,
} from "./ports.js";

export type DefaultRuntimeState = {
  databases: Map<string, DatabaseSync>;
  projectsDir: string;
  dataDir: string;
  projectStorageDirs: Map<string, string>;
  sweepTimer: ReturnType<typeof setInterval> | null;
  initialized: boolean;
  activeProjectIds: Set<string>;
  inFlightSweeps: Set<Promise<unknown>>;
  configWatcher: {
    watchers: FSWatcher[];
    snapshotsByBaseDir: Map<string, unknown>;
  };
  identity: {
    platformSecret: string | null;
    identities: Map<string, unknown>;
  };
  configRegistry: {
    globalAgents: Map<string, unknown>;
    domainAgents: Map<string, Set<string>>;
    agentDomains: Map<string, Set<string>>;
  };
  configInit: {
    managedDomainsByBaseDir: Map<string, Set<string>>;
    domainOwnerBaseDirs: Map<string, string>;
    reloadStatusByDomain: Map<string, unknown>;
  };
  managerConfig: {
    registry: Map<string, unknown>;
  };
  policy: {
    cache: Map<string, unknown[]>;
  };
  projectConfig: {
    agentConfigRegistry: Map<string, unknown>;
    bareAgentAliases: Map<string, string>;
    bareAgentQualifiedIds: Map<string, Set<string>>;
    runtimeAgentAliases: Map<string, string>;
    runtimeAgentQualifiedIds: Map<string, Set<string>>;
    projectAgentIds: Map<string, Set<string>>;
    approvalPolicies: Map<string, unknown>;
    projectExtendedConfig: Map<string, unknown>;
  };
  notifications: {
    adapterRegistry: Map<string, unknown>;
  };
  dispatch: {
    globalMaxConcurrency: number;
    globalActiveDispatches: number;
    projectDispatches: Map<string, number>;
    projectDispatchTimestamps: Map<string, number[]>;
    agentDispatches: Map<string, number>;
    agentDispatchTimestamps: Map<string, number[]>;
  };
  workerRegistry: {
    assignments: Map<string, unknown>;
    acquireLease: unknown | null;
  };
  rateLimiter: {
    sessionCallCounts: Map<string, number>;
    globalCallTimestamps: number[];
    agentCallTimestamps: Map<string, number[]>;
    projectCallTimestamps: Map<string, number[]>;
  };
  rateLimits: {
    providerUsage: Map<string, unknown>;
  };
  pricing: {
    dynamicPricing: Map<string, unknown>;
  };
  risk: {
    bulkActionTimestamps: Map<string, number[]>;
  };
  safety: {
    channelMessageTimestamps: Map<string, number[]>;
  };
  taskCompliance: {
    trackedWorkers: Map<string, unknown>;
  };
  triggers: {
    cooldowns: Map<string, number>;
  };
  contextAssembler: {
    cache: Map<string, string | null>;
  };
  configInference: {
    inferredAgents: Map<string, boolean>;
  };
  enforcementTracker: {
    sessions: Map<string, unknown>;
  };
  skills: {
    customTopicsStore: Map<string, unknown[]>;
  };
  taskTool: {
    sessionTaskCreationCounts: Map<string, number>;
  };
  controller: {
    instanceId: string | null;
    generation: string | null;
  };
  openClaw: OpenClawSessionState;
  dashboardAuth: {
    rateLimitMap: Map<string, unknown>;
    cleanupTimer: ReturnType<typeof setInterval> | null;
  };
  integrations: RuntimeIntegrationState;
};

const defaultRuntimeState: DefaultRuntimeState = {
  databases: new Map(),
  projectsDir: getClawforceHome(),
  dataDir: path.join(getClawforceHome(), "data"),
  projectStorageDirs: new Map(),
  sweepTimer: null,
  initialized: false,
  activeProjectIds: new Set(),
  inFlightSweeps: new Set(),
  configWatcher: {
    watchers: [],
    snapshotsByBaseDir: new Map(),
  },
  identity: {
    platformSecret: null,
    identities: new Map(),
  },
  configRegistry: {
    globalAgents: new Map(),
    domainAgents: new Map(),
    agentDomains: new Map(),
  },
  configInit: {
    managedDomainsByBaseDir: new Map(),
    domainOwnerBaseDirs: new Map(),
    reloadStatusByDomain: new Map(),
  },
  managerConfig: {
    registry: new Map(),
  },
  policy: {
    cache: new Map(),
  },
  projectConfig: {
    agentConfigRegistry: new Map(),
    bareAgentAliases: new Map(),
    bareAgentQualifiedIds: new Map(),
    runtimeAgentAliases: new Map(),
    runtimeAgentQualifiedIds: new Map(),
    projectAgentIds: new Map(),
    approvalPolicies: new Map(),
    projectExtendedConfig: new Map(),
  },
  notifications: {
    adapterRegistry: new Map(),
  },
  dispatch: {
    globalMaxConcurrency: 3,
    globalActiveDispatches: 0,
    projectDispatches: new Map(),
    projectDispatchTimestamps: new Map(),
    agentDispatches: new Map(),
    agentDispatchTimestamps: new Map(),
  },
  workerRegistry: {
    assignments: new Map(),
    acquireLease: null,
  },
  rateLimiter: {
    sessionCallCounts: new Map(),
    globalCallTimestamps: [],
    agentCallTimestamps: new Map(),
    projectCallTimestamps: new Map(),
  },
  rateLimits: {
    providerUsage: new Map(),
  },
  pricing: {
    dynamicPricing: new Map(),
  },
  risk: {
    bulkActionTimestamps: new Map(),
  },
  safety: {
    channelMessageTimestamps: new Map(),
  },
  taskCompliance: {
    trackedWorkers: new Map(),
  },
  triggers: {
    cooldowns: new Map(),
  },
  contextAssembler: {
    cache: new Map(),
  },
  configInference: {
    inferredAgents: new Map(),
  },
  enforcementTracker: {
    sessions: new Map(),
  },
  skills: {
    customTopicsStore: new Map(),
  },
  taskTool: {
    sessionTaskCreationCounts: new Map(),
  },
  controller: {
    instanceId: null,
    generation: null,
  },
  openClaw: {
    memoryModeBySession: new Map(),
    sessionTurnCounts: new Map(),
    meetingSessions: new Map(),
  },
  dashboardAuth: {
    rateLimitMap: new Map(),
    cleanupTimer: null,
  },
  integrations: {
    deliveryAdapter: null,
    approvalNotifier: null,
    messageNotifier: null,
    channelNotifier: null,
    notificationDeliveryAdapter: null,
    killFunction: null,
    dispatchInjector: null,
    cronService: null,
    diagnosticEmitter: null,
    sseManager: null,
    openClawConfigSnapshot: null,
    dispatchExecutors: new Map(),
  },
};

export function getDefaultRuntimeState(): DefaultRuntimeState {
  return defaultRuntimeState;
}
