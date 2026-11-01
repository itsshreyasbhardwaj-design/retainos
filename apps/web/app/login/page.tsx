import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { LoginForm } from "./form";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/dashboard");
  return (
    <div className="flex min-h-screen items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <span aria-hidden className="h-7 w-7 rounded-md bg-gradient-to-br from-blue-500 to-cyan-500" />
          <span className="text-base font-semibold tracking-tight text-offwhite">RetainOS</span>
        </Link>
        <div className="rounded-xl border border-navy-700/70 bg-navy-900/60 p-6">
          <h1 className="text-lg font-semibold tracking-tight text-offwhite">Log in</h1>
          <p className="mt-1.5 text-xs text-slate-400">Welcome back.</p>
          <LoginForm />
        </div>
        <p className="mt-5 text-center text-xs text-slate-500">
          No account?{" "}
          <Link href="/signup" className="text-blue-400 underline decoration-blue-400/40 hover:decoration-blue-400">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
