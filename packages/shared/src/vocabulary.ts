/**
 * Shared domain vocabulary.
 *
 * These lists are needed on both sides of the network boundary: the server
 * validates against them and the browser renders them. They live here rather
 * than in @retainos/database precisely so that importing a status list into a
 * client component cannot drag a SQLite driver into the browser bundle.
 */

export type FeedbackKind = "bug" | "feature_request" | "improvement" | "confusion" | "general";

export type FeedbackStatus =
  | "new" | "under_review" | "planned" | "in_progress" | "released" | "closed" | "duplicate";

export const FEEDBACK_STATUSES: FeedbackStatus[] = [
  "new", "under_review", "planned", "in_progress", "released", "closed", "duplicate",
];

export const FEEDBACK_KINDS: Array<{ id: FeedbackKind; label: string }> = [
  { id: "bug", label: "Report a bug" },
  { id: "feature_request", label: "Request a feature" },
  { id: "improvement", label: "Suggest an improvement" },
  { id: "confusion", label: "Report confusing behaviour" },
  { id: "general", label: "Share general feedback" },
];

export type ImprovementStatus =
  | "detected" | "investigating" | "validated" | "planned" | "approved"
  | "in_development" | "in_review" | "released" | "measuring" | "resolved"
  | "not_effective" | "closed";

export const IMPROVEMENT_STATUSES: ImprovementStatus[] = [
  "detected", "investigating", "validated", "planned", "approved",
  "in_development", "in_review", "released", "measuring", "resolved",
  "not_effective", "closed",
];

/**
 * Permitted status moves.
 *
 * FixFlow is a workflow, not a free-text field: a task cannot jump from
 * "detected" straight to "released", because that would leave an audit trail
 * claiming work was approved and shipped without either step happening.
 */
export const IMPROVEMENT_TRANSITIONS: Record<ImprovementStatus, ImprovementStatus[]> = {
  detected: ["investigating", "validated", "closed"],
  investigating: ["validated", "detected", "closed"],
  validated: ["planned", "investigating", "closed"],
  planned: ["approved", "validated", "closed"],
  approved: ["in_development", "planned", "closed"],
  in_development: ["in_review", "approved", "closed"],
  in_review: ["released", "in_development", "closed"],
  released: ["measuring", "closed"],
  measuring: ["resolved", "not_effective", "closed"],
  resolved: ["closed", "measuring"],
  not_effective: ["planned", "closed", "measuring"],
  closed: ["detected"],
};

export function canTransition(from: ImprovementStatus, to: ImprovementStatus): boolean {
  return IMPROVEMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export type ImprovementOutcome =
  | "improvement_supported" | "no_clear_difference" | "worse_outcome"
  | "inconclusive" | "invalid_experiment";
