import path from "node:path";
import os from "node:os";

/** Resolve the ClawForce base directory, respecting CLAWFORCE_HOME env var */
export function getClawforceHome(): string {
  return process.env.CLAWFORCE_HOME ?? path.join(os.homedir(), ".clawforce");
}
