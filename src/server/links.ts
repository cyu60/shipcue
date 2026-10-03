// Links to the fix on the public changelog (shipcue report dae35160): a report's PR, or the first
// GitHub link in its resolution, shown only when anyone could open it anyway (a public
// repository) or to an admin.

const REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/i;
const FIX_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|commit|issues|compare)\/[\w.]+/i;

/** The first link to a GitHub pull request, commit or issue in some text. */
export function findGitHubLink(text: string | null | undefined): string | null {
  return text ? (FIX_LINK.exec(text)?.[0] ?? null) : null;
}

export interface PublicGitHubLinksOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** How long an answer is kept per repository. An hour by default. */
  cacheMs?: number;
  /** Give up on GitHub after this long and hide the link. 3 s by default. */
  timeoutMs?: number;
}

/**
 * A boardLinks check: true only for links into public GitHub repositories, asked of GitHub's API
 * once per repository and remembered. Anything else, or a lookup that fails, stays hidden.
 */
export function publicGitHubLinks(opts: PublicGitHubLinksOptions = {}): (url: string) => Promise<boolean> {
  const doFetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const cacheMs = opts.cacheMs ?? 60 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const known = new Map<string, { open: boolean; at: number }>();
  return async (url) => {
    const m = REPO.exec(url);
    if (!m) return false;
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    const hit = known.get(repo);
    if (hit && Date.now() - hit.at < cacheMs) return hit.open;
    let open = false;
    try {
      const res = await doFetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'shipcue' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      open = res.ok && !((await res.json().catch(() => ({}))) as { private?: boolean }).private;
    } catch {
      open = false;
    }
    known.set(repo, { open, at: Date.now() });
    return open;
  };
}
