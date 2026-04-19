import type { ClawforceOptions } from "./types.js";
import { TasksNamespace } from "./tasks.js";
import { EventsNamespace } from "./events.js";
import { BudgetNamespace } from "./budget.js";
import { AgentsNamespace } from "./agents.js";
import { TrustNamespace } from "./trust.js";
import { GoalsNamespace } from "./goals.js";
import { EntitiesNamespace } from "./entities.js";
import { KnowledgeNamespace } from "./knowledge.js";
import { MessagesNamespace } from "./messages.js";
import { MonitoringNamespace } from "./monitoring.js";
import { DbNamespace } from "./db.js";
import { DispatchNamespace } from "./dispatch.js";
import { ConfigNamespace } from "./config.js";
import { HooksNamespace } from "./hooks.js";
import { ApprovalsNamespace } from "./approvals.js";
import { TriggersNamespace } from "./triggers.js";
import { TelemetryNamespace } from "./telemetry.js";

export class Clawforce {
  readonly domain: string;
  private readonly opts: ClawforceOptions;

  private _tasks?: TasksNamespace;
  private _events?: EventsNamespace;
  private _budget?: BudgetNamespace;
  private _agents?: AgentsNamespace;
  private _trust?: TrustNamespace;
  private _goals?: GoalsNamespace;
  private _entities?: EntitiesNamespace;
  private _knowledge?: KnowledgeNamespace;
  private _messages?: MessagesNamespace;
  private _monitoring?: MonitoringNamespace;
  private _db?: DbNamespace;
  private _dispatch?: DispatchNamespace;
  private _config?: ConfigNamespace;
  private _hooks?: HooksNamespace;
  private _approvals?: ApprovalsNamespace;
  private _triggers?: TriggersNamespace;
  private _telemetry?: TelemetryNamespace;

  private constructor(opts: ClawforceOptions) {
    this.opts = opts;
    this.domain = opts.domain;
  }

  static init(opts: ClawforceOptions): Clawforce {
    return new Clawforce(opts);
  }

  get tasks(): TasksNamespace {
    return (this._tasks ??= new TasksNamespace(this.domain, () => this.hooks));
  }
  get events(): EventsNamespace {
    return (this._events ??= new EventsNamespace(this.domain));
  }
  get budget(): BudgetNamespace {
    return (this._budget ??= new BudgetNamespace(this.domain, () => this.hooks));
  }
  get agents(): AgentsNamespace {
    return (this._agents ??= new AgentsNamespace(this.domain));
  }
  get trust(): TrustNamespace {
    return (this._trust ??= new TrustNamespace(this.domain));
  }
  get goals(): GoalsNamespace {
    return (this._goals ??= new GoalsNamespace(this.domain));
  }
  get entities(): EntitiesNamespace {
    return (this._entities ??= new EntitiesNamespace(this.domain));
  }
  get knowledge(): KnowledgeNamespace {
    return (this._knowledge ??= new KnowledgeNamespace(this.domain));
  }
  get messages(): MessagesNamespace {
    return (this._messages ??= new MessagesNamespace(this.domain));
  }
  get monitoring(): MonitoringNamespace {
    return (this._monitoring ??= new MonitoringNamespace(this.domain));
  }
  get db(): DbNamespace {
    return (this._db ??= new DbNamespace(this.domain));
  }
  get dispatch(): DispatchNamespace {
    return (this._dispatch ??= new DispatchNamespace(this.domain, () => this.hooks));
  }
  get config(): ConfigNamespace {
    return (this._config ??= new ConfigNamespace(this.domain));
  }
  get hooks(): HooksNamespace {
    return (this._hooks ??= new HooksNamespace(this.domain));
  }
  get approvals(): ApprovalsNamespace {
    return (this._approvals ??= new ApprovalsNamespace(this.domain));
  }
  get triggers(): TriggersNamespace {
    return (this._triggers ??= new TriggersNamespace(this.domain));
  }
  get telemetry(): TelemetryNamespace {
    return (this._telemetry ??= new TelemetryNamespace(this.domain));
  }
}

// Re-export all public types
export * from "./types.js";
