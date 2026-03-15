import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CommandCenter } from "./views/CommandCenter";
import { TaskBoard } from "./views/TaskBoard";
import { ApprovalQueue } from "./views/ApprovalQueue";
import { OrgChart } from "./views/OrgChart";
import { Analytics } from "./views/Analytics";
import { CommsCenter } from "./views/CommsCenter";
import { ConfigEditor } from "./views/ConfigEditor";
import { InitiativeView } from "./views/InitiativeView";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CommandCenter />} />
        <Route path="tasks" element={<TaskBoard />} />
        <Route path="approvals" element={<ApprovalQueue />} />
        <Route path="org" element={<OrgChart />} />
        <Route path="comms" element={<CommsCenter />} />
        <Route path="config" element={<ConfigEditor />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="initiatives/:id" element={<InitiativeView />} />
      </Route>
    </Routes>
  );
}
