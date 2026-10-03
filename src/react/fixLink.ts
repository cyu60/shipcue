/** "PR #12", "#7", a short commit sha, or "GitHub": how a link to a fix reads, on the board and in the CueLog. */
export function fixLabel(url: string): string {
  const m = /\/(pull|issues|commit|compare)\/([\w.]+)/.exec(url);
  return m?.[1] === 'pull' ? `PR #${m[2]}` : m?.[1] === 'issues' ? `#${m[2]}` : m?.[1] === 'commit' ? m[2]!.slice(0, 7) : 'GitHub';
}
