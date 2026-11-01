import Link from "next/link";
import { appContext } from "@/lib/session";
import { Sidebar } from "@/components/nav";
import { Switcher } from "@/components/switcher";
import { logoutAction, switchOrgAction, switchProjectAction } from "@/lib/actions-auth";
import { ROLE_LABELS } from "@retainos/shared";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await appContext();

  return (
    <div className="lg:flex">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 border-b border-navy-700/60 bg-navy-950/90 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <Switcher
              orgs={ctx.orgs}
              currentOrgId={ctx.org.id}
              projects={ctx.projects}
              currentProjectId={ctx.project?.id ?? null}
              onSwitchOrg={switchOrgAction}
              onSwitchProject={switchProjectAction}
            />
            <div className="flex items-center gap-3 text-xs">
              <span className="hidden text-slate-500 sm:inline">
                {ctx.user.name} · {ROLE_LABELS[ctx.org.role]}
              </span>
              <Link href="/settings" className="text-slate-400 hover:text-offwhite">Settings</Link>
              <form action={logoutAction}>
                <button type="submit" className="text-slate-400 hover:text-offwhite">Log out</button>
              </form>
            </div>
          </div>
        </header>
        <main className="px-5 py-6 pb-16">{children}</main>
      </div>
    </div>
  );
}
