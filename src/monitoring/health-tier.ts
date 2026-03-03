/**
 * Clawforce — Health tier rollup
 *
 * Pure function that computes an overall project health tier
 * from SLO, alert, and anomaly counts.
 */

export type HealthTier = "GREEN" | "YELLOW" | "RED";

export type HealthTierInput = {
  sloChecked: number;
  sloBreach: number;
  alertsFired: number;
  anomaliesDetected: number;
};

/**
 * Compute overall health tier from monitoring sweep results.
 *
 * - RED:    50%+ SLO breaches OR 3+ alerts fired
 * - YELLOW: any breach OR alert OR anomaly
 * - GREEN:  all clear
 */
export function computeHealthTier(input: HealthTierInput): HealthTier {
  const { sloChecked, sloBreach, alertsFired, anomaliesDetected } = input;

  // RED: 50%+ SLO breaches (when SLOs are checked) OR 3+ alerts
  if (alertsFired >= 3) return "RED";
  if (sloChecked > 0 && sloBreach / sloChecked >= 0.5) return "RED";

  // YELLOW: any breach, alert, or anomaly
  if (sloBreach > 0 || alertsFired > 0 || anomaliesDetected > 0) return "YELLOW";

  // GREEN: all clear
  return "GREEN";
}
