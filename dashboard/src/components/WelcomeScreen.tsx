import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";

type OnboardingPath = "governance" | "new" | "demo";

export function WelcomeScreen() {
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const openAssistant = useAppStore((s) => s.openAssistantWithContext);
  const queryClient = useQueryClient();

  const handlePathClick = (path: OnboardingPath) => {
    switch (path) {
      case "governance":
        openAssistant(
          "The user wants to add Clawforce to an existing OpenClaw project. Start by asking about their current agents.",
        );
        break;
      case "new":
        openAssistant(
          "The user wants to create a new AI workforce from scratch. Start by asking about their use case.",
        );
        break;
      case "demo":
        createDemo();
        break;
    }
  };

  const createDemo = async () => {
    setDemoLoading(true);
    setDemoError(null);
    try {
      const result = await api.createDemo();
      // After demo creation, refresh domains and invalidate all cached queries
      const projects = await api.getProjects();
      const { setDomains, setActiveDomain } = useAppStore.getState();
      setDomains(projects);
      if (result.domainId) {
        setActiveDomain(result.domainId);
      }
      // Invalidate all queries so views re-fetch with the new domain data
      await queryClient.invalidateQueries();
    } catch (err) {
      setDemoError(
        err instanceof Error ? err.message : "Failed to create demo",
      );
    } finally {
      setDemoLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-120px)]">
      <div className="max-w-3xl w-full px-6">
        {/* Logo / Branding */}
        <div className="flex flex-col items-center mb-10">
          <div className="mb-5">
            <img src="/logo.svg" alt="Clawforce" className="w-20 h-20" />
          </div>
          <h1 className="text-3xl font-bold text-cf-text-primary mb-3 text-center">
            Welcome to Clawforce
          </h1>
          <p className="text-cf-text-secondary text-center text-sm leading-relaxed max-w-md">
            The accountability layer for your AI workforce. Set budgets, enforce
            compliance, and organize your agents into a governed team.
          </p>
        </div>

        {/* Path Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {/* Card 1: Add governance */}
          <button
            onClick={() => handlePathClick("governance")}
            className="group bg-cf-bg-secondary border border-cf-border rounded-xl p-5 text-left transition-all hover:border-cf-accent-blue/50 hover:shadow-lg hover:shadow-cf-accent-blue/5 hover:-translate-y-0.5 focus:outline-none focus:border-cf-accent-blue"
          >
            <div className="w-10 h-10 rounded-lg bg-cf-accent-blue/10 flex items-center justify-center mb-4 group-hover:bg-cf-accent-blue/20 transition-colors">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                className="text-cf-accent-blue"
              >
                <path
                  d="M10 2L3 6v4c0 4.42 2.98 8.56 7 9.6 4.02-1.04 7-5.18 7-9.6V6l-7-4z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M7 10l2 2 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-cf-text-primary mb-2">
              Add governance to existing project
            </h3>
            <p className="text-xxs text-cf-text-muted leading-relaxed">
              I already have OpenClaw agents. Help me add budget enforcement,
              compliance, and org structure.
            </p>
          </button>

          {/* Card 2: Start new */}
          <button
            onClick={() => handlePathClick("new")}
            className="group bg-cf-bg-secondary border border-cf-border rounded-xl p-5 text-left transition-all hover:border-cf-accent-green/50 hover:shadow-lg hover:shadow-cf-accent-green/5 hover:-translate-y-0.5 focus:outline-none focus:border-cf-accent-green"
          >
            <div className="w-10 h-10 rounded-lg bg-cf-accent-green/10 flex items-center justify-center mb-4 group-hover:bg-cf-accent-green/20 transition-colors">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                className="text-cf-accent-green"
              >
                <circle
                  cx="10"
                  cy="10"
                  r="7.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M10 7v6M7 10h6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-cf-text-primary mb-2">
              Start a new AI workforce
            </h3>
            <p className="text-xxs text-cf-text-muted leading-relaxed">
              I'm building from scratch. Help me design my team, set budgets,
              and get started.
            </p>
          </button>

          {/* Card 3: Explore demo */}
          <button
            onClick={() => handlePathClick("demo")}
            disabled={demoLoading}
            className="group bg-cf-bg-secondary border border-cf-border rounded-xl p-5 text-left transition-all hover:border-cf-accent-purple/50 hover:shadow-lg hover:shadow-cf-accent-purple/5 hover:-translate-y-0.5 focus:outline-none focus:border-cf-accent-purple disabled:opacity-60 disabled:cursor-wait disabled:hover:translate-y-0"
          >
            <div className="w-10 h-10 rounded-lg bg-cf-accent-purple/10 flex items-center justify-center mb-4 group-hover:bg-cf-accent-purple/20 transition-colors">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                className="text-cf-accent-purple"
              >
                <rect
                  x="3"
                  y="3"
                  width="14"
                  height="14"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M8 7l5 3-5 3V7z"
                  fill="currentColor"
                  opacity="0.8"
                />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-cf-text-primary mb-2">
              {demoLoading ? "Creating demo..." : "Explore with a demo"}
            </h3>
            <p className="text-xxs text-cf-text-muted leading-relaxed">
              {demoLoading
                ? "Setting up a sample team with 10 agents, 3 departments, and budget controls..."
                : "Create a sample team so I can see how Clawforce works."}
            </p>
          </button>
        </div>

        {/* Demo error */}
        {demoError && (
          <div className="text-center">
            <p className="text-xs text-cf-accent-red">{demoError}</p>
          </div>
        )}

        {/* Footer hint */}
        <div className="text-center">
          <p className="text-xxs text-cf-text-muted">
            You can always change your setup later from the Config editor.
          </p>
        </div>
      </div>
    </div>
  );
}
