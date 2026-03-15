import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CommandCenter } from "./views/CommandCenter";
import { TaskBoard } from "./views/TaskBoard";
import { ApprovalQueue } from "./views/ApprovalQueue";
import { OrgChart } from "./views/OrgChart";
import { Analytics } from "./views/Analytics";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CommandCenter />} />
        <Route path="tasks" element={<TaskBoard />} />
        <Route path="approvals" element={<ApprovalQueue />} />
        <Route path="org" element={<OrgChart />} />
        <Route path="comms" element={<Placeholder name="Comms Center" />} />
        <Route path="config" element={<Placeholder name="Config Editor" />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="initiatives/:id" element={<Placeholder name="Initiative Detail" />} />
      </Route>
    </Routes>
  );
}

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <p className="text-cf-text-muted text-lg">{name} — coming soon</p>
    </div>
  );
}
