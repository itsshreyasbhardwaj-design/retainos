import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Documentation" };

function Code({ children, lang }: { children: string; lang?: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-navy-700/70 bg-navy-950 px-4 py-3 text-[12px] leading-relaxed">
      <code className="font-mono text-slate-300">{children}</code>
      {lang ? <span className="sr-only">{lang}</span> : null}
    </pre>
  );
}

export default function Docs() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">Documentation</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        You should be able to send your first real event and see it arrive in a few minutes. Everything here works
        against a local instance with no external service.
      </p>

      <Section n={1} title="Create a project and copy the key">
        <p>
          A project gets a public write key that looks like <code className="rounded bg-navy-800 px-1 py-0.5 font-mono text-[11px]">rpk_…</code>.
          It is not a secret: it ships in your browser bundle and may only append events to that one project.
          Private keys, which can read, start with <code className="rounded bg-navy-800 px-1 py-0.5 font-mono text-[11px]">rsk_…</code>,
          are shown once, and are stored only as a hash.
        </p>
      </Section>

      <Section n={2} title="Install the SDK">
        <Code>{`pnpm add @retainos/sdk`}</Code>
        <p>Zero dependencies. It works in any browser and in Node.</p>
      </Section>

      <Section n={3} title="Initialise it">
        <Code>{`import { RetainOS } from "@retainos/sdk";

export const retain = RetainOS.init({
  projectKey: process.env.NEXT_PUBLIC_RETAINOS_KEY!,
  endpoint: "https://your-retainos-instance.example",
  autoCapture: false,
});`}</Code>
        <p>
          <strong className="text-slate-300">autoCapture is off by default.</strong> Automatic page-view capture
          is a decision for you to make deliberately. Even when on, it records paths only — never query strings,
          which routinely carry tokens and search terms.
        </p>
      </Section>

      <Section n={4} title="Grant consent, then track">
        <Code>{`// Nothing leaves the device until this is called.
retain.grantConsent();

retain.track("signup_completed");

retain.identify("USER_123");

retain.track("core_action_completed", {
  feature: "first_project",
});`}</Code>
        <p>
          Pass a stable pseudonymous id to <code className="font-mono text-[11px]">identify()</code>. It rejects
          anything that looks like an email address: RetainOS does not need one, and this stops a direct
          identifier reaching the event store by accident.
        </p>
      </Section>

      <Section n={5} title="Reset on logout">
        <Code>{`retain.reset(); // flushes, clears the user, issues a fresh anonymous id`}</Code>
        <p>Without this, the next person on a shared device is attributed to the previous one.</p>
      </Section>

      <Section n={6} title="Confirm it arrived">
        <p>
          Open <Link href="/settings/sdk" className="text-blue-400 underline decoration-blue-400/40">SDK &amp; events</Link>{" "}
          in your project. The inspector shows accepted events and, more usefully, rejected ones with the exact
          reason: a malformed event name, a property outside the schema, a missing consent flag.
        </p>
      </Section>

      <Section n={7} title="Server-side tracking">
        <p>The same SDK works in Node, or post directly to the ingestion endpoint:</p>
        <Code>{`curl -X POST https://your-instance.example/api/v1/ingest \\
  -H "content-type: application/json" \\
  -H "x-retainos-key: rpk_YOUR_KEY" \\
  -H "x-retainos-idempotency-key: batch-2026-03-14-001" \\
  -d '{
    "events": [
      { "name": "subscription_started",
        "userId": "USER_123",
        "consent": true,
        "properties": { "plan": "growth" } }
    ]
  }'`}</Code>
        <p>
          The idempotency header makes a retried batch a no-op rather than a double count. Each event may also
          carry its own <code className="font-mono text-[11px]">eventId</code> for per-event deduplication.
        </p>
      </Section>

      <Section n={8} title="React">
        <Code>{`"use client";
import { RetainOSProvider, useRetainOS } from "@retainos/sdk/react";

export function Providers({ children }) {
  return (
    <RetainOSProvider
      options={{ projectKey: process.env.NEXT_PUBLIC_RETAINOS_KEY!, endpoint: "/" }}
    >
      {children}
    </RetainOSProvider>
  );
}

function CreateButton() {
  const retain = useRetainOS();
  return <button onClick={() => retain?.track("project_created")}>Create</button>;
}`}</Code>
      </Section>

      <Section n={9} title="Define what activation means">
        <p>
          This is the step most teams skip, and the one that makes everything else useful. RetainOS will not
          guess: pick the single event that means a user reached real value in <em>your</em> product. Signup is
          never it.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>A developer tool: first successful integration.</li>
          <li>A project manager: first project created with an actionable task.</li>
          <li>A content tool: first finished asset exported.</li>
          <li>A finance app: first useful report completed.</li>
        </ul>
      </Section>

      <Section n={10} title="Event naming">
        <p>
          Event names must be lower_snake_case. The registry suggests outcome names over interaction names —
          <code className="font-mono text-[11px]"> project_created</code> rather than
          <code className="font-mono text-[11px]"> clicked_create</code> — because outcomes survive a redesign and
          button names do not.
        </p>
      </Section>

      <div className="mt-10 rounded-xl border border-navy-700/70 bg-navy-900/50 p-5">
        <h2 className="text-sm font-semibold text-offwhite">Reference documentation</h2>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          The repository carries deeper documents on each subsystem: the ingestion pipeline, how each metric is
          defined, the experiment safeguards, the GitHub integration, security and privacy, and a feature-status
          table recording exactly what is verified and what is not.
        </p>
      </div>
    </div>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2.5 text-base font-semibold text-offwhite">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-600/20 text-xs text-blue-400">
          {n}
        </span>
        {title}
      </h2>
      <div className="mt-2.5 space-y-3 text-sm leading-relaxed text-slate-400">{children}</div>
    </section>
  );
}
