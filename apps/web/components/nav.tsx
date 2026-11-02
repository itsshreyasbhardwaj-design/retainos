"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cx } from "./ui.tsx";

export interface NavGroup {
  label: string;
  items: Array<{ href: string; label: string; locked?: boolean }>;
}

/**
 * Application navigation.
 *
 * Grouped by the question each section answers rather than by module name, so
 * the information architecture matches how a founder thinks: what happened,
 * what are people telling us, what are we doing about it, did it work.
 */
export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/command", label: "Command centre" },
      { href: "/dashboard", label: "Metrics overview" },
      { href: "/alerts", label: "Alerts" },
    ],
  },
  {
    label: "What is happening",
    items: [
      { href: "/analytics", label: "Analytics" },
      { href: "/analytics/funnels", label: "Funnels" },
      { href: "/activation", label: "Activation" },
      { href: "/retention", label: "Retention" },
      { href: "/revenue", label: "Revenue" },
      { href: "/health", label: "Customer health" },
    ],
  },
  {
    label: "What people say",
    items: [
      { href: "/feedback", label: "Feedback inbox" },
      { href: "/feedback/requests", label: "Feature requests" },
      { href: "/feedback/roadmap", label: "Roadmap" },
    ],
  },
  {
    label: "What to fix",
    items: [
      { href: "/friction", label: "FrictionGraph" },
      { href: "/opportunities", label: "Opportunities" },
    ],
  },
  {
    label: "What we are doing",
    items: [
      { href: "/improvements", label: "Improvements" },
      { href: "/playbooks", label: "Playbooks" },
      { href: "/releases", label: "Releases" },
      { href: "/onboarding-builder", label: "Onboarding" },
    ],
  },
  {
    label: "Did it work",
    items: [
      { href: "/impact", label: "ImpactLab" },
      { href: "/revenue/impact", label: "Revenue impact" },
      { href: "/experiments", label: "Experiments" },
    ],
  },
  {
    label: "Analysis",
    items: [
      { href: "/ai", label: "RetainAI" },
      { href: "/reports", label: "Reports" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { href: "/settings", label: "Settings" },
      { href: "/settings/sdk", label: "SDK & events" },
      { href: "/settings/instrumentation", label: "Instrumentation doctor" },
      { href: "/settings/sources", label: "Data sources" },
      { href: "/settings/integrations", label: "Integrations" },
      { href: "/settings/team", label: "Team" },
      { href: "/settings/billing", label: "Plan & usage" },
      { href: "/settings/privacy", label: "Privacy" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="retainos-nav"
        className="sticky top-0 z-20 flex w-full items-center gap-2 border-b border-navy-700/60 bg-navy-950/95
                   px-4 py-3 text-sm font-medium text-offwhite backdrop-blur lg:hidden"
      >
        <span aria-hidden className="text-base leading-none">{open ? "×" : "☰"}</span>
        Menu
      </button>

      <nav
        id="retainos-nav"
        aria-label="Main"
        className={cx(
          "border-b border-navy-700/60 bg-navy-900/40 px-3 py-4 lg:sticky lg:top-0 lg:h-screen lg:w-60",
          "lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-r",
          open ? "block" : "hidden lg:block",
        )}
      >
        <Link href="/dashboard" className="mb-5 flex items-center gap-2 px-2">
          <span aria-hidden className="h-6 w-6 rounded-md bg-gradient-to-br from-blue-500 to-cyan-500" />
          <span className="text-sm font-semibold tracking-tight text-offwhite">RetainOS</span>
        </Link>

        {NAV.map((group) => (
          <div key={group.label} className="mb-4">
            <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={isActive(item.href) ? "page" : undefined}
                    className={cx(
                      "block rounded-lg px-2 py-1.5 text-[13px] transition-colors",
                      isActive(item.href)
                        ? "bg-blue-600/15 font-medium text-blue-400"
                        : "text-slate-400 hover:bg-navy-800 hover:text-offwhite",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
