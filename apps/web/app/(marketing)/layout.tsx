import Link from "next/link";

const LINKS = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/integrations", label: "Integrations" },
];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-navy-950">
      <header className="sticky top-0 z-30 border-b border-navy-700/50 bg-navy-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5">
          <Link href="/" className="flex items-center gap-2">
            <span aria-hidden className="h-6 w-6 rounded-md bg-gradient-to-br from-blue-500 to-cyan-500" />
            <span className="text-sm font-semibold tracking-tight text-offwhite">RetainOS</span>
          </Link>
          <nav aria-label="Marketing" className="hidden items-center gap-5 md:flex">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="text-[13px] text-slate-400 transition-colors hover:text-offwhite">
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-lg px-3 py-1.5 text-[13px] text-slate-400 hover:text-offwhite">
              Log in
            </Link>
            <Link href="/signup" className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-blue-500">
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main>{children}</main>

      <footer className="mt-20 border-t border-navy-700/50 px-5 py-10">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 text-xs text-slate-500 md:flex-row md:justify-between">
          <div className="max-w-sm">
            <p className="font-medium text-slate-400">RetainOS</p>
            <p className="mt-2 leading-relaxed">
              Find the friction. Fix the experience. Prove the impact.
            </p>
            <p className="mt-3 leading-relaxed">
              RetainOS is open source and runs locally with no paid service. It is an independent product and is
              not affiliated with any analytics vendor named on this site.
            </p>
          </div>
          <div className="flex gap-10">
            <div>
              <p className="mb-2 font-medium text-slate-400">Product</p>
              <ul className="space-y-1.5">
                {LINKS.map((l) => <li key={l.href}><Link href={l.href} className="hover:text-offwhite">{l.label}</Link></li>)}
                <li><Link href="/demo" className="hover:text-offwhite">Demo</Link></li>
              </ul>
            </div>
            <div>
              <p className="mb-2 font-medium text-slate-400">Legal</p>
              <ul className="space-y-1.5">
                <li><Link href="/privacy" className="hover:text-offwhite">Privacy</Link></li>
                <li><Link href="/terms" className="hover:text-offwhite">Terms</Link></li>
              </ul>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
