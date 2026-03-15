import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Loading } from "./components/Loading";

const CommandCenter = lazy(() => import("./views/CommandCenter"));
const TaskBoard = lazy(() => import("./views/TaskBoard"));
const ApprovalQueue = lazy(() => import("./views/ApprovalQueue"));
const OrgChart = lazy(() => import("./views/OrgChart"));
const Analytics = lazy(() => import("./views/Analytics"));
const CommsCenter = lazy(() => import("./views/CommsCenter"));
const ConfigEditor = lazy(() => import("./views/ConfigEditor"));
const InitiativeView = lazy(() => import("./views/InitiativeView"));

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Suspense fallback={<Loading />}>
          <Route index element={<CommandCenter />} />
          <Route path="tasks" element={<TaskBoard />} />
          <Route path="approvals" element={<ApprovalQueue />} />
          <Route path="org" element={<OrgChart />} />
          <Route path="comms" element={<CommsCenter />} />
          <Route path="config" element={<ConfigEditor />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="initiatives/:id" element={<InitiativeView />} />
        </Suspense>
      </Route>
    </Routes>
  );
}
