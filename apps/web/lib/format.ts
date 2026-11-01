/** Formatting helpers. Every one of them renders "unknown" honestly. */

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-IN").format(Math.round(value));
}

export function money(minor: number | null | undefined, currency = "INR"): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(minor / 100);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function when(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

export function relative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const diff = now - ms;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** A signed delta in percentage points, for period comparisons. */
export function deltaPoints(current: number | null, prior: number | null): { label: string; tone: "up" | "down" | "flat" | "unknown" } {
  if (current === null || prior === null) return { label: "no comparison", tone: "unknown" };
  const d = (current - prior) * 100;
  if (Math.abs(d) < 0.05) return { label: "flat", tone: "flat" };
  return { label: `${d > 0 ? "+" : ""}${d.toFixed(1)} pts`, tone: d > 0 ? "up" : "down" };
}

export function titleCase(input: string): string {
  return input.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
