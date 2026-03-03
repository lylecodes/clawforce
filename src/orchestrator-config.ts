/**
 * @deprecated Use manager-config.ts instead.
 * This file re-exports everything from manager-config for backward compatibility.
 */
export {
  type ManagerSettings as OrchestratorSettings,
  type ManagerSettings,
  registerManagerProject as registerOrchestratorProject,
  registerManagerProject,
  getManagerForAgent as getOrchestratorForAgent,
  getManagerForAgent,
  isManagerSession as isOrchestratorSession,
  isManagerSession,
  unregisterManagerProject as unregisterOrchestratorProject,
  unregisterManagerProject,
  resetManagerConfigForTest as resetOrchestratorConfigForTest,
  resetManagerConfigForTest,
} from "./manager-config.js";
