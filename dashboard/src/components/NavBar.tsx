import { NavLink } from "react-router-dom";
import { DomainSwitcher } from "./DomainSwitcher";

const navItems = [
  { to: "/", label: "Command Center", end: true },
  { to: "/tasks", label: "Tasks" },
  { to: "/approvals", label: "Approvals" },
  { to: "/org", label: "Org Chart" },
  { to: "/comms", label: "Comms" },
  { to: "/config", label: "Config" },
  { to: "/analytics", label: "Analytics" },
];

export function NavBar() {
  return (
    <header className="border-b border-cf-border bg-cf-bg-secondary sticky top-0 z-50">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
        {/* Top row: logo + domain switcher */}
        <div className="flex items-center justify-between h-12">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-cf-text-primary tracking-tight">
              Clawforce
            </span>
            <span className="text-xxs text-cf-text-muted font-mono uppercase tracking-wider">
              Dashboard
            </span>
          </div>
          <DomainSwitcher />
        </div>

        {/* Navigation tabs */}
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                  isActive
                    ? "border-cf-accent-blue text-cf-text-primary"
                    : "border-transparent text-cf-text-secondary hover:text-cf-text-primary hover:border-cf-border"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
