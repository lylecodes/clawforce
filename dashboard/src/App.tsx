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

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<SuspenseWrapper><CommandCenter /></SuspenseWrapper>} />
        <Route path="tasks" element={<SuspenseWrapper><TaskBoard /></SuspenseWrapper>} />
        <Route path="approvals" element={<SuspenseWrapper><ApprovalQueue /></SuspenseWrapper>} />
        <Route path="org" element={<SuspenseWrapper><OrgChart /></SuspenseWrapper>} />
        <Route path="comms" element={<SuspenseWrapper><CommsCenter /></SuspenseWrapper>} />
        <Route path="config" element={<SuspenseWrapper><ConfigEditor /></SuspenseWrapper>} />
        <Route path="analytics" element={<SuspenseWrapper><Analytics /></SuspenseWrapper>} />
        <Route path="initiatives/:id" element={<SuspenseWrapper><InitiativeView /></SuspenseWrapper>} />
      </Route>
    </Routes>
  );
}
