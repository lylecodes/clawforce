import { create } from "zustand";

export type Domain = {
  id: string;
  agentCount: number;
};

type AppState = {
  /** Currently active domain (project) ID */
  activeDomain: string | null;
  /** All available domains */
  domains: Domain[];
  /** Recent activity events (for the activity feed) */
  activityEvents: ActivityEvent[];

  setActiveDomain: (domain: string | null) => void;
  setDomains: (domains: Domain[]) => void;
  addActivityEvent: (event: ActivityEvent) => void;
};

export type ActivityEvent = {
  id: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
};

export const useAppStore = create<AppState>((set) => ({
  activeDomain: localStorage.getItem("clawforce:activeDomain"),
  domains: [],
  activityEvents: [],

  setActiveDomain: (domain) => {
    if (domain) {
      localStorage.setItem("clawforce:activeDomain", domain);
    } else {
      localStorage.removeItem("clawforce:activeDomain");
    }
    set({ activeDomain: domain });
  },

  setDomains: (domains) => {
    set((state) => {
      // Auto-select first domain if none selected
      const activeDomain =
        state.activeDomain && domains.some((d) => d.id === state.activeDomain)
          ? state.activeDomain
          : domains[0]?.id ?? null;
      return { domains, activeDomain };
    });
  },

  addActivityEvent: (event) =>
    set((state) => ({
      activityEvents: [event, ...state.activityEvents].slice(0, 200),
    })),
}));
