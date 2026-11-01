import type { Metadata } from "next";
import { appContext } from "@/lib/session";
import { db } from "@/lib/db";
import { listAudit, entitlementFor } from "@retainos/database";
import { ROLES, ROLE_LABELS, ROLE_PERMISSIONS, PERMISSIONS, type Role, type Permission } from "@retainos/shared";
import { PageHeader, Card, CardHeader, CardBody, Badge, Table, Th, Td, Caveats } from "@/components/ui";
import { num, relative, titleCase } from "@/lib/format";
import { TeamForm } from "./form";

export const metadata: Metadata = { title: "Team" };
export const dynamic = "force-dynamic";

export default async function Team() {
  const ctx = await appContext();
  const handle = db();
  const now = Date.now();
  const entitlement = entitlementFor(handle, ctx.org.id);

  const members = handle.all<{ id: string; name: string; email: string; role: string; created_at: number }>(
    `SELECT u.id, u.name, u.email, m.role, m.created_at
       FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? ORDER BY m.created_at ASC`,
    [ctx.org.id],
  );
  const audit = listAudit(handle, ctx.org.id, 20) as Array<Record<string, unknown>>;

  return (
    <>
      <PageHeader
        title="Team"
        description={`${num(members.length)} of ${num(entitlement.limits.teamMembers)} seats on the ${entitlement.planId} plan. Every permission is enforced server-side.`}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Members" />
            <CardBody>
              <Table>
                <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th align="right">Joined</Th></tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <Td>{m.name}{m.id === ctx.user.id ? <span className="ml-1.5 text-[11px] text-slate-500">you</span> : null}</Td>
                      <Td><span className="font-mono text-[11px] text-slate-400">{m.email}</span></Td>
                      <Td><Badge tone={m.role === "owner" ? "good" : m.role === "admin" ? "info" : "neutral"}>
                        {ROLE_LABELS[m.role as Role] ?? m.role}
                      </Badge></Td>
                      <Td align="right">{relative(m.created_at, now)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What each role can do"
              subtitle="Permission sets are explicit, so a new role cannot silently inherit something dangerous."
            />
            <CardBody>
              <div className="-mx-5 overflow-x-auto px-5">
                <table className="border-collapse text-xs">
                  <thead>
                    <tr>
                      <Th className="pr-3">Permission</Th>
                      {ROLES.map((r) => <Th key={r} align="right" className="px-2">{ROLE_LABELS[r]}</Th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {PERMISSIONS.map((p) => (
                      <tr key={p}>
                        <Td className="whitespace-nowrap pr-3 font-mono text-[11px]">{p}</Td>
                        {ROLES.map((r) => (
                          <td key={r} className="border-b border-navy-800/60 px-2 py-2 text-center">
                            {ROLE_PERMISSIONS[r].has(p as Permission)
                              ? <span className="text-emerald-400" aria-label="allowed">✓</span>
                              : <span className="text-slate-700" aria-label="not allowed">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Audit log" subtitle="Append-only. Every permission change, key, dispatch and erasure." />
            <CardBody>
              {audit.length === 0 ? (
                <p className="text-xs text-slate-400">Nothing recorded yet.</p>
              ) : (
                <Table>
                  <thead><tr><Th>Action</Th><Th>Target</Th><Th align="right">When</Th></tr></thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={String(a.id)}>
                        <Td><code className="font-mono text-[11px] text-slate-300">{String(a.action)}</code></Td>
                        <Td><span className="text-[11px] text-slate-500">{String(a.target_kind ?? "—")}</span></Td>
                        <Td align="right">{relative(Number(a.created_at), now)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <TeamForm
            canManage={ctx.org.role === "owner" || ctx.org.role === "admin"}
            isOwner={ctx.org.role === "owner"}
            seatsLeft={Math.max(0, entitlement.limits.teamMembers - members.length)}
          />
          <Caveats items={[
            "RetainOS has no email provider configured by default, so it cannot send an invitation. A teammate is added directly and you give them their password out of band.",
            "Only an owner can grant the owner role.",
            "Seat limits are enforced on the server, in the only code path that adds a member.",
          ]} />
        </div>
      </div>
    </>
  );
}
