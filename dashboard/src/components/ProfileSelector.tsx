type Profile = {
  id: string;
  label: string;
  description: string;
  estimatedCostPerDay: string;
  color: string;
};

const PROFILES: Profile[] = [
  {
    id: "low",
    label: "Low",
    description: "Conservative spending. Agents check in infrequently, minimal autonomous action.",
    estimatedCostPerDay: "$0.50-2.00",
    color: "border-cf-accent-green",
  },
  {
    id: "medium",
    label: "Medium",
    description: "Balanced approach. Regular check-ins, moderate autonomy with guardrails.",
    estimatedCostPerDay: "$2.00-8.00",
    color: "border-cf-accent-blue",
  },
  {
    id: "high",
    label: "High",
    description: "Active workforce. Frequent activity, broad autonomy, fast iteration.",
    estimatedCostPerDay: "$8.00-25.00",
    color: "border-cf-accent-orange",
  },
  {
    id: "ultra",
    label: "Ultra",
    description: "Maximum throughput. Continuous operation, minimal approval gates.",
    estimatedCostPerDay: "$25.00+",
    color: "border-cf-accent-red",
  },
];

type ProfileSelectorProps = {
  selected: string;
  onSelect: (profileId: string) => void;
};

export function ProfileSelector({ selected, onSelect }: ProfileSelectorProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {PROFILES.map((profile) => (
        <button
          key={profile.id}
          onClick={() => onSelect(profile.id)}
          className={`text-left p-3 rounded-lg border-2 transition-all ${
            selected === profile.id
              ? `${profile.color} bg-cf-bg-tertiary`
              : "border-cf-border bg-cf-bg-secondary hover:border-cf-text-muted"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-cf-text-primary">
              {profile.label}
            </span>
            {selected === profile.id && (
              <span className="w-2 h-2 rounded-full bg-cf-accent-blue" />
            )}
          </div>

          <p className="text-xxs text-cf-text-secondary leading-relaxed mb-2">
            {profile.description}
          </p>

          <p className="text-xxs text-cf-text-muted font-mono">
            ~{profile.estimatedCostPerDay}/day
          </p>
        </button>
      ))}
    </div>
  );
}
