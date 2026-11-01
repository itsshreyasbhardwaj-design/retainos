import type { ReactNode } from "react";

/**
 * UI primitives, in the shadcn/ui idiom.
 *
 * Vendored directly rather than generated, so the whole surface is readable in
 * one file and carries no extra dependency. Each component is a thin wrapper
 * over semantic HTML with the project's design tokens applied.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-xl border border-navy-700/70 bg-navy-900/60 backdrop-blur-sm", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-navy-700/60 px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-offwhite">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs leading-relaxed text-slate-400">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("px-5 py-4", className)}>{children}</div>;
}

export function Button({
  children, variant = "primary", size = "md", type = "button", disabled, name, value,
  className, formAction, onClick, title,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  name?: string;
  value?: string;
  className?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  /** Only usable from a client component. */
  onClick?: () => void;
  title?: string;
}) {
  const variants = {
    primary: "bg-blue-600 text-white hover:bg-blue-500 border-blue-600",
    secondary: "bg-navy-800 text-offwhite hover:bg-navy-700 border-navy-600",
    ghost: "bg-transparent text-slate-400 hover:text-offwhite hover:bg-navy-800 border-transparent",
    danger: "bg-rose-500/15 text-rose-500 hover:bg-rose-500/25 border-rose-500/40",
  };
  return (
    <button
      type={type}
      name={name}
      value={value}
      disabled={disabled}
      formAction={formAction}
      onClick={onClick}
      title={title}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({
  children, tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "good" | "warn" | "bad" | "accent";
}) {
  const tones = {
    neutral: "bg-navy-800 text-slate-400 border-navy-600",
    info: "bg-blue-600/15 text-blue-400 border-blue-600/40",
    good: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
    warn: "bg-amber-500/15 text-amber-500 border-amber-500/40",
    bad: "bg-rose-500/15 text-rose-500 border-rose-500/40",
    accent: "bg-cyan-500/15 text-cyan-400 border-cyan-500/40",
  };
  return (
    <span className={cx(
      "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
      tones[tone],
    )}>
      {children}
    </span>
  );
}

/**
 * A metric tile.
 *
 * `definition` is required, not optional. Every number RetainOS shows must be
 * able to explain what it counted, so the type system insists on it.
 */
export function Metric({
  label, value, definition, delta, tone, caveat,
}: {
  label: string;
  value: ReactNode;
  definition: string;
  delta?: { label: string; tone: "up" | "down" | "flat" | "unknown" };
  tone?: "good" | "bad" | "neutral";
  caveat?: string | null;
}) {
  const deltaTones = {
    up: "text-emerald-400",
    down: "text-rose-500",
    flat: "text-slate-400",
    unknown: "text-slate-500",
  };
  return (
    <div className="rounded-xl border border-navy-700/70 bg-navy-900/60 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        {delta ? <span className={cx("text-[11px] tnum", deltaTones[delta.tone])}>{delta.label}</span> : null}
      </div>
      <div className={cx(
        "mt-1.5 text-2xl font-semibold tnum tracking-tight",
        tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-500" : "text-offwhite",
      )}>
        {value}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-slate-500">{definition}</p>
      {caveat ? (
        <p className="mt-1.5 text-[11px] leading-snug text-amber-500/90">{caveat}</p>
      ) : null}
    </div>
  );
}

/** An empty state that says what to do, not just that there is nothing. */
export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-navy-600 bg-navy-900/30 px-6 py-10 text-center">
      <h3 className="text-sm font-semibold text-offwhite">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-400">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A caveat block.
 *
 * Used wherever a figure could be over-read. Deliberately prominent rather
 * than tucked into a tooltip: hiding limitations behind an attractive chart is
 * the failure mode this product exists to avoid.
 */
export function Caveats({ items, tone = "warn" }: { items: string[]; tone?: "warn" | "info" }) {
  if (items.length === 0) return null;
  return (
    <div className={cx(
      "rounded-lg border px-3.5 py-3 text-xs leading-relaxed",
      tone === "warn"
        ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-500/90"
        : "border-blue-600/30 bg-blue-600/[0.06] text-blue-400/90",
    )}>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = "left", className }: { children?: ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <th className={cx(
      "border-b border-navy-700/60 pb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500",
      align === "right" ? "text-right" : "text-left",
      className,
    )}>
      {children}
    </th>
  );
}

export function Td({ children, align = "left", className }: { children?: ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <td className={cx(
      "border-b border-navy-800/60 py-2.5 text-slate-300",
      align === "right" ? "text-right tnum" : "text-left",
      className,
    )}>
      {children}
    </td>
  );
}

export function Field({
  label, name, type = "text", defaultValue, placeholder, hint, required, autoComplete, children,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  autoComplete?: string;
  children?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>
      {children ?? (
        <input
          name={name}
          type={type}
          defaultValue={defaultValue}
          placeholder={placeholder}
          required={required}
          autoComplete={autoComplete}
          className="w-full rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-2 text-sm text-offwhite
                     placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
        />
      )}
      {hint ? <span className="mt-1.5 block text-[11px] leading-snug text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Select({
  label, name, options, defaultValue, hint,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
  hint?: string;
}) {
  return (
    <Field label={label} name={name} hint={hint}>
      <select
        name={name}
        defaultValue={defaultValue}
        className="w-full rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-2 text-sm text-offwhite
                   focus:border-blue-500 focus:outline-none"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

export function Textarea({
  label, name, defaultValue, rows = 4, placeholder, hint, required,
}: {
  label: string; name: string; defaultValue?: string; rows?: number;
  placeholder?: string; hint?: string; required?: boolean;
}) {
  return (
    <Field label={label} name={name} hint={hint}>
      <textarea
        name={name}
        rows={rows}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full rounded-lg border border-navy-600 bg-navy-950/60 px-3 py-2 text-sm text-offwhite
                   placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
      />
    </Field>
  );
}

export function PageHeader({
  title, description, action,
}: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-offwhite">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-400">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A horizontal bar, used for funnel steps and distributions. */
export function Bar({ fraction, tone = "blue" }: { fraction: number; tone?: "blue" | "cyan" | "emerald" | "rose" }) {
  const tones = { blue: "bg-blue-500", cyan: "bg-cyan-500", emerald: "bg-emerald-500", rose: "bg-rose-500" };
  const width = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-navy-800" role="presentation">
      <div className={cx("h-full rounded-full transition-[width]", tones[tone])} style={{ width: `${width}%` }} />
    </div>
  );
}

/** Confidence label, rendered with its basis available on hover. */
export function Confidence({ label, basis }: { label: string; basis?: string }) {
  const tones: Record<string, "good" | "info" | "warn" | "neutral"> = {
    strong_supporting_evidence: "good",
    moderate_supporting_evidence: "info",
    preliminary_observation: "warn",
    insufficient_data: "neutral",
  };
  return (
    <span title={basis}>
      <Badge tone={tones[label] ?? "neutral"}>{label.replace(/_/g, " ")}</Badge>
    </span>
  );
}

export function ErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-500">
      {message}
    </div>
  );
}

export function SuccessBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-400">
      {message}
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="mb-5 rounded-lg border border-cyan-500/40 bg-cyan-500/[0.07] px-4 py-3 text-xs leading-relaxed text-cyan-400">
      <strong className="font-semibold">Demonstration data.</strong>{" "}
      Every figure on this screen comes from a fictional seeded project. The numbers reconcile with each other
      but describe no real company, and this project is kept separate from any production data.
    </div>
  );
}
