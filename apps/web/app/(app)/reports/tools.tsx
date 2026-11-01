"use client";

import { useActionState, useState } from "react";
import { generateReportAction } from "@/lib/actions";
import { Card, CardHeader, CardBody, Button, ErrorBanner, SuccessBanner } from "@/components/ui";

export function ReportTools({ markdown, projectName }: { markdown: string; projectName: string }) {
  const [state, generate, generating] = useActionState(generateReportAction, {} as { error?: string; ok?: string });
  const [showMarkdown, setShowMarkdown] = useState(false);

  const download = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const date = new Date().toISOString().slice(0, 10);

  return (
    <Card>
      <CardHeader
        title="Weekly retention brief"
        subtitle="Computed live from your own data every time this page loads."
        action={
          <form action={generate}>
            <Button type="submit" variant="secondary" size="sm" disabled={generating}>
              {generating ? "Saving…" : "Save a snapshot"}
            </Button>
          </form>
        }
      />
      <CardBody>
        <ErrorBanner message={state?.error} />
        <SuccessBanner message={state?.ok} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowMarkdown((v) => !v)}>
            {showMarkdown ? "Hide" : "View"} as Markdown
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => download(markdown, `retainos-brief-${slug}-${date}.md`, "text/markdown")}
          >
            Download Markdown
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.print()}
          >
            Print or save as PDF
          </Button>
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
          PDF export uses your browser&apos;s own print-to-PDF, so RetainOS needs no rendering service and no
          external dependency to produce one.
        </p>
        {showMarkdown ? (
          <pre className="mt-4 max-h-96 overflow-auto rounded-lg border border-navy-700/70 bg-navy-950 px-4 py-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-slate-400">
            {markdown}
          </pre>
        ) : null}
      </CardBody>
    </Card>
  );
}
