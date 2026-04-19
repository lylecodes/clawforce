/**
 * Clawforce — Signed agent identity
 *
 * HMAC-SHA256 signed identity per agent. Used for signing transitions,
 * delegation contracts, and audit trail entries.
 * Adapted from the agent-identity.ts reference implementation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProjectsDir } from "./db.js";
import { getDefaultRuntimeState } from "./runtime/default-runtime.js";

export type AgentIdentity = {
  agentId: string;
  hmacKey: string;
  identityToken: string;
  issuedAt: number;
};

type IdentityRuntimeState = {
  platformSecret: string | null;
  identities: Map<string, AgentIdentity>;
};

const runtime = getDefaultRuntimeState();

function getIdentityState(): IdentityRuntimeState {
  return runtime.identity as IdentityRuntimeState;
}

function secretPath(): string {
  return path.join(getProjectsDir(), "platform-secret");
}

function ensurePlatformSecret(): string {
  const state = getIdentityState();
  if (state.platformSecret) return state.platformSecret;

  const sp = secretPath();
  try {
    state.platformSecret = fs.readFileSync(sp, "utf-8").trim();
    if (state.platformSecret) return state.platformSecret;
  } catch {
    // Generate new
  }

  state.platformSecret = crypto.randomBytes(64).toString("hex");
  const dir = path.dirname(sp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sp, state.platformSecret, { mode: 0o600 });
  return state.platformSecret;
}

function deriveHmacKey(agentId: string): string {
  const secret = ensurePlatformSecret();
  return crypto.createHmac("sha256", secret).update(`agent:${agentId}`).digest("hex");
}

export function getAgentIdentity(agentId: string): AgentIdentity {
  const state = getIdentityState();
  const existing = state.identities.get(agentId);
  if (existing) return existing;

  const hmacKey = deriveHmacKey(agentId);
  const identityToken = crypto
    .createHash("sha256")
    .update(`identity:${agentId}:${hmacKey}`)
    .digest("hex")
    .slice(0, 32);

  const identity: AgentIdentity = {
    agentId,
    hmacKey,
    identityToken,
    issuedAt: Date.now(),
  };
  state.identities.set(agentId, identity);
  return identity;
}

/** Sign a transition or action for audit trail. */
export function signAction(agentId: string, data: string): string {
  const identity = getAgentIdentity(agentId);
  return crypto.createHmac("sha256", identity.hmacKey).update(data).digest("hex");
}

/** Verify a signed action. */
export function verifyAction(agentId: string, data: string, signature: string): boolean {
  const identity = getAgentIdentity(agentId);
  const expected = crypto.createHmac("sha256", identity.hmacKey).update(data).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function resetIdentitiesForTest(): void {
  const state = getIdentityState();
  state.identities.clear();
  state.platformSecret = null;
}
