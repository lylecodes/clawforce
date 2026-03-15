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
  /** Whether the domains list has been fetched at least once */
  domainsLoaded: boolean;
  /** Recent activity events (for the activity feed) */
  activityEvents: ActivityEvent[];
  /** Context message to pre-load into the assistant widget on open */
  assistantInitialContext: string | null;
  /** Whether the assistant widget should be open */
  assistantOpen: boolean;

  setActiveDomain: (domain: string | null) => void;
  setDomains: (domains: Domain[]) => void;
  addActivityEvent: (event: ActivityEvent) => void;
  /** Open the assistant widget with a pre-loaded context message */
  openAssistantWithContext: (context: string) => void;
  /** Clear the initial context after it has been consumed */
  clearAssistantContext: () => void;
  setAssistantOpen: (open: boolean) => void;
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
  domainsLoaded: false,
  activityEvents: [],
  assistantInitialContext: null,
  assistantOpen: false,

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
      // Auto-select first domain if none selected, or validate stored domain still exists
      const activeDomain =
        state.activeDomain && domains.some((d) => d.id === state.activeDomain)
          ? state.activeDomain
          : domains[0]?.id ?? null;
      // Persist the (possibly corrected) activeDomain
      if (activeDomain) {
        localStorage.setItem("clawforce:activeDomain", activeDomain);
      } else {
        localStorage.removeItem("clawforce:activeDomain");
      }
      return { domains, activeDomain, domainsLoaded: true };
    });
  },

  addActivityEvent: (event) =>
    set((state) => ({
      activityEvents: [event, ...state.activityEvents].slice(0, 200),
    })),

  openAssistantWithContext: (context) =>
    set({ assistantInitialContext: context, assistantOpen: true }),

  clearAssistantContext: () =>
    set({ assistantInitialContext: null }),

  setAssistantOpen: (open) =>
    set({ assistantOpen: open }),
}));
