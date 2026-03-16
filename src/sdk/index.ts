import type { ClawforceOptions } from "./types.js";
import { TasksNamespace } from "./tasks.js";
import { EventsNamespace } from "./events.js";
import { BudgetNamespace } from "./budget.js";
import { AgentsNamespace } from "./agents.js";
import { TrustNamespace } from "./trust.js";
import { GoalsNamespace } from "./goals.js";
import { MessagesNamespace } from "./messages.js";
import { MonitoringNamespace } from "./monitoring.js";

export class Clawforce {
  readonly domain: string;
  private readonly opts: ClawforceOptions;

  private _tasks?: TasksNamespace;
  private _events?: EventsNamespace;
  private _budget?: BudgetNamespace;
  private _agents?: AgentsNamespace;
  private _trust?: TrustNamespace;
  private _goals?: GoalsNamespace;
  private _messages?: MessagesNamespace;
  private _monitoring?: MonitoringNamespace;

  private constructor(opts: ClawforceOptions) {
    this.opts = opts;
    this.domain = opts.domain;
  }

  static init(opts: ClawforceOptions): Clawforce {
    return new Clawforce(opts);
  }

  get tasks(): TasksNamespace {
    return (this._tasks ??= new TasksNamespace(this.domain));
  }
  get events(): EventsNamespace {
    return (this._events ??= new EventsNamespace(this.domain));
  }
  get budget(): BudgetNamespace {
    return (this._budget ??= new BudgetNamespace(this.domain));
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
  get messages(): MessagesNamespace {
    return (this._messages ??= new MessagesNamespace(this.domain));
  }
  get monitoring(): MonitoringNamespace {
    return (this._monitoring ??= new MonitoringNamespace(this.domain));
  }
}

// Re-export all public types
export * from "./types.js";
