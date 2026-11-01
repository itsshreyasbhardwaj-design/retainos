/**
 * Confidence labelling.
 *
 * RetainOS never shows an invented numeric confidence. It shows one of four
 * qualitative labels, and always shows the rule that produced it, so a founder
 * can judge the judgement.
 */
export type ConfidenceLabel =
  | "strong_supporting_evidence"
  | "moderate_supporting_evidence"
  | "preliminary_observation"
  | "insufficient_data";

export const CONFIDENCE_LABELS: Record<ConfidenceLabel, string> = {
  strong_supporting_evidence: "Strong supporting evidence",
  moderate_supporting_evidence: "Moderate supporting evidence",
  preliminary_observation: "Preliminary observation",
  insufficient_data: "Insufficient data",
};

export interface ConfidenceInput {
  /** Users the observation is based on. */
  affectedUsers: number;
  /** Total population it is drawn from, when there is one. */
  population?: number;
  /** Magnitude of the effect, as a fraction (e.g. 0.3 = 30 percentage points). */
  effectSize?: number;
  /** Whether a second, independent source agrees (e.g. feedback plus telemetry). */
  corroborated?: boolean;
  /** Whether the comparison period is complete. */
  periodComplete?: boolean;
}

export interface ConfidenceAssessment {
  label: ConfidenceLabel;
  basis: string;
}

const MIN_USERS_FOR_ANY_CLAIM = 10;
const MIN_USERS_FOR_MODERATE = 50;
const MIN_USERS_FOR_STRONG = 200;
const MEANINGFUL_EFFECT = 0.1;
const LARGE_EFFECT = 0.25;

/**
 * Assign a confidence label from explicit, auditable rules.
 *
 * The rules are deliberately conservative: a large effect on 30 users is a
 * preliminary observation, not a finding. Everything rests on sample size
 * first, then effect size, then corroboration.
 */
export function assessConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const reasons: string[] = [];
  const { affectedUsers, population, effectSize, corroborated, periodComplete } = input;

  if (affectedUsers < MIN_USERS_FOR_ANY_CLAIM) {
    return {
      label: "insufficient_data",
      basis: `Only ${affectedUsers} users are involved, below the minimum of ${MIN_USERS_FOR_ANY_CLAIM} ` +
             "needed to say anything. This is reported so you know the signal exists, not as a finding.",
    };
  }
  if (periodComplete === false) {
    return {
      label: "preliminary_observation",
      basis: "The comparison period has not fully elapsed, so the figures will still move.",
    };
  }

  reasons.push(`${affectedUsers} users involved`);
  if (population !== undefined && population > 0) {
    reasons.push(`out of ${population} (${((affectedUsers / population) * 100).toFixed(0)}%)`);
  }
  if (effectSize !== undefined) {
    reasons.push(`effect size ${(effectSize * 100).toFixed(0)} points`);
  }
  if (corroborated) reasons.push("corroborated by a second independent source");

  const bigSample = affectedUsers >= MIN_USERS_FOR_STRONG;
  const midSample = affectedUsers >= MIN_USERS_FOR_MODERATE;
  const bigEffect = effectSize !== undefined && Math.abs(effectSize) >= LARGE_EFFECT;
  const realEffect = effectSize !== undefined && Math.abs(effectSize) >= MEANINGFUL_EFFECT;

  let label: ConfidenceLabel;
  if (bigSample && (bigEffect || (realEffect && corroborated))) {
    label = "strong_supporting_evidence";
  } else if ((bigSample && realEffect) || (midSample && (bigEffect || corroborated))) {
    label = "moderate_supporting_evidence";
  } else {
    label = "preliminary_observation";
  }

  return {
    label,
    basis:
      `${CONFIDENCE_LABELS[label]} based on: ${reasons.join(", ")}. ` +
      `Thresholds: strong needs ${MIN_USERS_FOR_STRONG}+ users with a ${LARGE_EFFECT * 100}-point effect ` +
      `(or a ${MEANINGFUL_EFFECT * 100}-point effect corroborated elsewhere); moderate needs ` +
      `${MIN_USERS_FOR_MODERATE}+ users. These are sample-size rules, not statistical confidence intervals.`,
  };
}
