import { useAppStore } from "../store";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export function DomainSwitcher() {
  const { activeDomain, setActiveDomain, setDomains, domains } = useAppStore();

  useQuery({
    queryKey: ["domains"],
    queryFn: async () => {
      const projects = await api.getProjects();
      setDomains(projects);
      return projects;
    },
    staleTime: 30_000,
  });

  if (domains.length === 0) {
    return (
      <div className="text-sm text-cf-text-muted">No domains available</div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {domains.map((domain) => (
        <button
          key={domain.id}
          onClick={() => setActiveDomain(domain.id)}
          className={`px-2.5 py-1 text-xs rounded-full transition-colors font-medium ${
            activeDomain === domain.id
              ? "bg-cf-accent-blue/20 text-cf-accent-blue border border-cf-accent-blue/40"
              : "bg-cf-bg-tertiary text-cf-text-secondary border border-cf-border hover:text-cf-text-primary hover:border-cf-text-muted"
          }`}
        >
          {domain.id}
          <span className="ml-1 text-xxs opacity-70">{domain.agentCount}</span>
        </button>
      ))}
    </div>
  );
}
