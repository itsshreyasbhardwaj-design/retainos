/**
 * GitHub dispatch.
 *
 * The token is read from the server environment at call time and never reaches
 * the browser. The only write this module can perform is creating an issue:
 * there is no code path here that pushes commits, opens pull requests or
 * modifies repository contents.
 */
export interface DispatchSuccess {
  issueNumber: number;
  issueUrl: string;
  state: string;
}
export interface DispatchFailure {
  error: string;
}

export async function dispatchGithubIssue(input: {
  repository: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<DispatchSuccess | DispatchFailure> {
  const token = process.env.RETAINOS_GITHUB_TOKEN;
  if (!token) {
    return {
      error:
        "No GitHub token is configured on the server. Set RETAINOS_GITHUB_TOKEN to a fine-grained token with " +
        "Issues: write on the target repository only. Nothing was sent.",
    };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    return { error: "Repository must be in 'owner/name' form." };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${input.repository}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "RetainOS",
      },
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
      // A hung request must not hold a server action open indefinitely.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Report the status and GitHub's own message, with the token nowhere near it.
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        /* keep the raw text */
      }
      const hint =
        res.status === 401 || res.status === 403
          ? " Check that the token is valid and has Issues: write on this repository."
          : res.status === 404
            ? " The repository was not found, or the token cannot see it."
            : "";
      return { error: `HTTP ${res.status}: ${detail}.${hint}` };
    }

    const issue = (await res.json()) as { number: number; html_url: string; state: string };
    return { issueNumber: issue.number, issueUrl: issue.html_url, state: issue.state };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { error: `Could not reach GitHub: ${message}` };
  }
}
