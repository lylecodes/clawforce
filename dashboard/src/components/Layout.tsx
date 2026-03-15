import { Outlet } from "react-router-dom";
import { NavBar } from "./NavBar";
import { AssistantWidget } from "./AssistantWidget";
import { useSSEConnection } from "../hooks/useSSE";
import { useAppStore } from "../store";

export function Layout() {
  const activeDomain = useAppStore((s) => s.activeDomain);

  // Maintain SSE connection for the active domain
  useSSEConnection(activeDomain);

  return (
    <div className="flex flex-col min-h-screen bg-cf-bg-primary">
      <NavBar />
      <main className="flex-1 p-4 lg:p-6 max-w-[1600px] w-full mx-auto">
        <Outlet />
      </main>
      <AssistantWidget />
    </div>
  );
}
