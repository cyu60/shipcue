// What `shipcue workflows init` writes: a fix-report workflow and the gates script it runs.

/** .shipcue/workflows/fix-report.yml: claim a report, build, review, gate, ask a person, merge, close. */
export function fixReportWorkflow(repo: string | null): string {
  return `# shipcue Workflows: one report, from claim to merged fix. Push with: npx shipcue workflows push
name: fix-report
on:
  manual: true                       # the Run button, \`npx shipcue run fix-report\`, or MCP start_run
  report: [filed]                    # every new report gets a run, waiting for a person's approval
approval: required                   # a person approves each run before it starts
inputs:
  report_id: { type: string, required: true }
steps:
  claim: { uses: shipcue/claim-report, with: { id: "\${{ inputs.report_id }}" } }
  build:
    needs: [claim]
    agent: claude
    on: local
${repo ? `    labels: [repo:${repo}]          # only runners with this checkout\n` : ''}    timeout: 90m
    prompt: |
      Fix report \${{ inputs.report_id }}: \${{ steps.claim.output.description }}.
      Work test-first on a new branch, run the checks, push, and open a PR whose body contains
      "Report: \${{ inputs.report_id }}".
    output:
      type: object
      required: [status]
      properties:
        status: { enum: [pr_opened, blocked, no_change_needed] }
        pr_url: { type: string }
        notes: { type: string }
  review:
    needs: [build]
    if: "\${{ steps.build.output.status == 'pr_opened' }}"
    agent: codex
    timeout: 45m
    prompt: "Adversarially review \${{ steps.build.output.pr_url }}: correctness, tests, security. Verdict ready or not_ready."
    output: { type: object, required: [verdict], properties: { verdict: { enum: [ready, not_ready] }, issues: { type: array, items: { type: string } } } }
  gates:
    needs: [review]
    if: "\${{ steps.review.output.verdict == 'ready' }}"
    run: sh ./scripts/ship-gates.sh  # deterministic: its exit code is the result
    env: { PR_URL: "\${{ steps.build.output.pr_url }}" }
    timeout: 30m
    retries: 1
  approve-merge:
    needs: [gates]
    approve: "Merge \${{ steps.build.output.pr_url }}?"
  merge:
    needs: [approve-merge]
    run: gh pr merge "$PR_URL" --squash
    env: { PR_URL: "\${{ steps.build.output.pr_url }}" }
  close:
    needs: [merge]
    uses: shipcue/close-report
    with: { id: "\${{ inputs.report_id }}", status: fixed, pr_url: "\${{ steps.build.output.pr_url }}" }
`;
}

/**
 * scripts/ship-gates.sh: rebase a PR on its base, run the repo's checks side by side, and push the
 * rebased branch. POSIX sh, for any repo; a port of agent-ops' ship.sh steps 1-5 without the parts
 * one app needed. Exit codes say which gate failed.
 */
export const SHIP_GATES = `#!/bin/sh
# ship-gates.sh: the deterministic gates before a merge (shipcue Workflows).
#   PR_URL=https://github.com/o/r/pull/7 sh scripts/ship-gates.sh
# 1. check out the PR, 2. rebase it on its base branch, 3. run the checks side by side,
# 4. push the rebased branch to the PR's own head (never the base), 5. print the head commit.
# The checks are the package.json scripts that exist (typecheck, lint, test, build); set
# SHIP_CHECKS="npm run a;npm test" to choose. Exit codes:
#   2 rebase conflict   3 not a PR   4 typecheck/lint   5 tests   6 build   7 push
set -u
[ -n "\${PR_URL:-}" ] || { echo "PR_URL is not set"; exit 3; }
command -v gh >/dev/null || { echo "gh is not installed"; exit 3; }
head=$(gh pr view "$PR_URL" --json headRefName -q .headRefName) || exit 3
base=$(gh pr view "$PR_URL" --json baseRefName -q .baseRefName) || exit 3
case "$head" in ""|"$base") echo "REFUSED: the PR's head is '$head'"; exit 7;; esac

git fetch -q origin "$base" "$head" || exit 3
git checkout -q -B "$head" "origin/$head" || exit 3
if ! git rebase -q "origin/$base"; then
  git rebase --abort 2>/dev/null
  echo "REBASE CONFLICT with $base"; exit 2
fi

logs=\${TMPDIR:-/tmp}/ship-gates.$$
mkdir -p "$logs"
pm=npm; [ -f pnpm-lock.yaml ] && pm=pnpm; [ -f yarn.lock ] && pm=yarn
if [ -f package.json ]; then
  case $pm in
    pnpm) pnpm install --frozen-lockfile >"$logs/install.log" 2>&1 || pnpm install >"$logs/install.log" 2>&1;;
    yarn) yarn install --frozen-lockfile >"$logs/install.log" 2>&1;;
    *) npm ci >"$logs/install.log" 2>&1 || npm install >"$logs/install.log" 2>&1;;
  esac
fi
has() { [ -f package.json ] && node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null; }

# The gates are independent: run them side by side, then collect.
pids=""
gate() { # gate <name> <exit code> <command>
  name=$1; code=$2; shift 2
  ( sh -c "$*" >"$logs/$name.log" 2>&1 || exit "$code" ) &
  pids="$pids $!:$name"
}
if [ -n "\${SHIP_CHECKS:-}" ]; then
  i=0
  echo "$SHIP_CHECKS" | tr ';' '\\n' | while read -r c; do [ -n "$c" ] && echo "$c"; done >"$logs/checks"
  while read -r c; do i=$((i + 1)); gate "check$i" 4 "$c"; done <"$logs/checks"
else
  has typecheck && gate typecheck 4 "$pm run typecheck"
  has lint && gate lint 4 "$pm run lint"
  has test && gate test 5 "$pm test"
  has build && gate build 6 "$pm run build"
fi
fail=0
for p in $pids; do
  pid=\${p%%:*}; name=\${p#*:}
  if wait "$pid"; then echo "$name ok"; else
    rc=$?; echo "$name FAILED"; tail -20 "$logs/$name.log"
    [ "$fail" = 0 ] && fail=$rc
  fi
done
[ "$fail" = 0 ] || exit "$fail"

git push -q --force-with-lease="$head:origin/$head" origin "HEAD:$head" || { echo "PUSH FAILED"; exit 7; }
[ "$(git ls-remote origin "refs/heads/$head" | cut -f1)" = "$(git rev-parse HEAD)" ] || { echo "PUSH FAILED: origin/$head is not HEAD"; exit 7; }
echo "gates ok"
echo "::output {\\"head\\":\\"$(git rev-parse HEAD)\\",\\"branch\\":\\"$head\\"}"
`;
