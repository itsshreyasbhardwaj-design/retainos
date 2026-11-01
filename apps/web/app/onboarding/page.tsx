import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { listOrganizationsForUser } from "@retainos/database";
import { db } from "@/lib/db";

/** Reached only when a signed-in user somehow has no organization. */
export default async function Onboarding() {
  const user = await requireUser();
  const orgs = listOrganizationsForUser(db(), user.id);
  if (orgs.length > 0) redirect("/dashboard");
  redirect("/signup");
}
