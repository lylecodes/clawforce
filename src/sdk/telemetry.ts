/**
 * Clawforce SDK — Telemetry Namespace
 *
 * Provides read access to session archives, config history,
 * trust timelines, and review statistics.
 */

import {
  getSessionArchive,
  listSessionArchives,
  type SessionArchive,
  type SessionArchiveFilters,
} from "../telemetry/session-archive.js";

import {
  getConfigHistory as internalGetConfigHistory,
  getConfigVersion as internalGetConfigVersion,
  type ConfigVersion,
} from "../telemetry/config-tracker.js";

import {
  getTrustTimeline as internalGetTrustTimeline,
  type TrustSnapshot,
} from "../telemetry/trust-history.js";

import {
  getReviewStats as internalGetReviewStats,
  type ReviewStats,
} from "../telemetry/review-store.js";

export class TelemetryNamespace {
  constructor(readonly domain: string) {}

  /**
   * Get full session archive detail by session key.
   */
  sessionDetail(sessionKey: string): SessionArchive | null {
    return getSessionArchive(this.domain, sessionKey);
  }

  /**
   * List session archives with optional filters and pagination.
   */
  listSessions(filters?: SessionArchiveFilters): SessionArchive[] {
    return listSessionArchives(this.domain, filters);
  }

  /**
   * Get config version history, optionally since a timestamp.
   */
  configHistory(since?: number): ConfigVersion[] {
    return internalGetConfigHistory(this.domain, since);
  }

  /**
   * Get a specific config version by ID.
   */
  configVersion(versionId: string): ConfigVersion | null {
    return internalGetConfigVersion(this.domain, versionId);
  }

  /**
   * Get trust score timeline, optionally filtered by agent and time range.
   */
  trustTimeline(agentId?: string, since?: number): TrustSnapshot[] {
    return internalGetTrustTimeline(this.domain, agentId, since);
  }

  /**
   * Get aggregate review statistics (approval/rejection rates).
   */
  reviewStats(): ReviewStats {
    return internalGetReviewStats(this.domain);
  }
}
