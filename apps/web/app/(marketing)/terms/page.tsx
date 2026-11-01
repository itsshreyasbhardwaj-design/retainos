import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-offwhite">Terms</h1>
      <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-xs leading-relaxed text-amber-500/90">
        This is a plain-language summary of how the software is intended to be used. It is not a reviewed legal
        agreement. Before offering RetainOS commercially, have terms drafted for your jurisdiction.
      </p>

      <Section title="The software">
        <p>
          RetainOS is open-source software provided under the Apache License 2.0, without warranty. You may run
          it, modify it and self-host it.
        </p>
      </Section>

      <Section title="Your data">
        <p>
          The product data you put into RetainOS is yours. Export is available on every plan, including after a
          subscription lapses, in JSON and CSV.
        </p>
        <p>
          You are the controller of the end-user data your instrumented application sends. You are responsible
          for having a lawful basis to collect it and for honouring your users&apos; rights, which RetainOS gives
          you the tools to do.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>
          Do not use RetainOS to track people without a lawful basis, to profile children behaviourally, or to
          collect the categories of sensitive data the software is built to refuse.
        </p>
      </Section>

      <Section title="Subscriptions">
        <p>
          Paid plans bill monthly or annually in advance. Cancellation takes effect at the end of the paid
          period, and is available as an ordinary setting without contacting anyone.
        </p>
        <p>
          A development deployment uses a billing simulator. A simulated payment is labelled as simulated
          everywhere it appears and is never reported as a real one.
        </p>
      </Section>

      <Section title="What we do not promise">
        <p>
          RetainOS does not promise that using it will improve your retention or recover revenue. It measures
          what happened and is explicit about the limits of that measurement. Any figure it describes as
          observed is not a forecast.
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
