import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">Privacy</h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        RetainOS is a tool for understanding how people use <em>someone else&apos;s</em> application. That makes
        data minimisation the central design problem, not a compliance afterthought. This page describes what the
        software actually does; it is not legal advice, and a deployment is responsible for its own obligations.
      </p>

      <Section title="What the SDK collects">
        <p>For each event: the event name, a timestamp, an identifier, and the properties your code passes.</p>
        <p>
          Alongside it: a coarse device category derived from the user agent (mobile, tablet, desktop) and a
          two-letter country code if your edge supplies one. The raw user agent string is never stored.
        </p>
      </Section>

      <Section title="What the SDK refuses to collect">
        <p>
          The SDK drops properties whose names or values look like credentials or sensitive personal data, and
          the server drops them again on arrival. That covers passwords, tokens, session identifiers, cookies,
          card numbers, CVVs, bank and routing numbers, government identifiers including Aadhaar and PAN,
          passport numbers, private keys and seed phrases, one-time codes, health and diagnosis fields, dates of
          birth, and precise coordinates.
        </p>
        <p>
          It also drops any non-scalar value, so passing a whole user object cannot smuggle an email address into
          analytics by accident.
        </p>
        <p>
          There is no session recording, no keystroke capture, no form-field capture, no clipboard access and no
          device fingerprinting. These are not disabled by default; they are not implemented, and there is no
          setting that turns them on.
        </p>
      </Section>

      <Section title="Identity">
        <p>
          A visitor gets a random anonymous identifier stored on their own device. When your application calls
          identify(), RetainOS links that anonymous identifier to the pseudonymous user id you supply, and
          records the link explicitly.
        </p>
        <p>
          Identities are only ever merged on an explicit identify() call. An anonymous identifier already claimed
          by one user is never reassigned to another, because that would merge two real people who share a
          device. Two identified users are never merged at all.
        </p>
        <p>identify() rejects values that look like email addresses, to keep direct identifiers out of the store.</p>
      </Section>

      <Section title="Consent">
        <p>
          A project can require explicit consent, and does by default. With it on, an event without a consent
          flag is rejected: the absence of a signal is not treated as agreement. The SDK queues nothing before
          consent is granted, and discards its queue if consent is withdrawn.
        </p>
        <p>
          End users can opt out entirely. Opting out clears the local identifiers and survives a page reload.
        </p>
      </Section>

      <Section title="Retention and deletion">
        <p>
          Each project sets how long raw events are kept. Aggregated counts outlive raw events, so history
          remains without retaining individual event rows.
        </p>
        <p>
          A deletion request for one end user removes their events, identity, experiment records and onboarding
          progress, anonymises their feedback rather than destroying the product signal, and detaches their
          subscription rows while leaving the financial records intact. Affected aggregates are recomputed, so
          the numbers stay consistent with the raw store instead of quietly disagreeing with it.
        </p>
      </Section>

      <Section title="Children and sensitive services">
        <p>
          India&apos;s Digital Personal Data Protection Act places specific obligations on processing children&apos;s
          data, including verifiable parental consent and a prohibition on behavioural monitoring and targeted
          advertising directed at children.
        </p>
        <p>
          RetainOS has no behavioural profiling and no advertising features at all, for any audience. If your
          application serves children, disable behavioural tracking for those users and take your own legal
          advice: RetainOS does not implement a parental consent mechanism, and switching it on would be your
          responsibility rather than something this software can do for you.
        </p>
        <p>
          Do not instrument flows that handle health or financial detail in a way that passes those values as
          event properties. The denylist is a safety net, not a substitute for not sending the data.
        </p>
      </Section>

      <Section title="Where the data lives">
        <p>
          A self-hosted deployment keeps everything on infrastructure you control. The local development setup
          writes to a SQLite file on your own machine and contacts no external service.
        </p>
        <p>
          Optional integrations — GitHub, a billing provider, a language-model adapter — are off unless you
          configure them, and each one states what it sends before you enable it.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold text-offwhite">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-slate-400">{children}</div>
    </section>
  );
}
