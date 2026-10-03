# Swarm mode: work-area claims and "Work this queue"

Design for shipcue report 83f5d976. One page; v1 is part (a) only.

## What people already do by hand

The outliner swarm (the `outliner-swarm` skill): one build agent per report, each in its own git worktree, branch and PR; an adversarial reviewer per PR that fixes on the branch; then one merge orchestrator (`ship.sh`) that rebases, settles append-only conflicts, runs every check, renames a migration so it sorts after main's newest, applies it before merging, merges, and waits for prod's `/api/version` to serve the commit. On 2026-10-03 two sessions on one repo coordinated that by hand: "I own these six reports", "hold merges until main is free", "my migrations are 1900–1999, take 2000+". The claim files (`habitect-claims`), open PRs and chat messages were the source of truth, and messages arrived late.

shipcue already has the pieces for the first half (atomic claims, per-agent tokens, leases, assignment, `in_review` with a PR link, history, `shipcue-listen`). What is missing is saying *what* a claim touches, and seeing collisions before the merge does.

## (a) Work-area claims

**A claim declares a scope**, all optional: `{ areas?: string[], paths?: string[], migration?: string, branch?: string }`. `areas` are the app's report areas or free words ("sync", "editor"); `paths` are file globs (`src/server/**`, `src/react/CueLog.tsx`; `*`, `**`, `?`; a plain path covers everything under it); `migration` is the slot the work will take (a timestamp or a named range, compared as text); `branch` is its git branch.

**Set it** on `POST reports/:id/claim { scope }` and `POST reports/next/claim { scope }`, change it with `POST|PUT reports/:id/scope { scope }` (holder only; `null` clears it), from MCP `claim_report` / `claim_next_report` (`scope` argument), or `shipcue-listen --scope '<json>'`, which hands it to the command as `SHIPCUE_SCOPE` so the agent's MCP server claims with it by default.

**Stored with the claim, not on the row:** in the history. The `claimed` event's detail carries the scope, and a later change is a `note` event with `{ text: "Work area: …", scope }`. A report's current scope is the newest of those, unless a newer `claimed`, `assigned`, `released`, `expired`, `reopened` or `closed` event came after it (a new holder starts clean). No new column and no schema change.

**Collisions:** two *active* claims (status `claimed` or `in_review`, since a PR in review still holds its files until it merges) collide when they share an area (case-insensitive), have path globs that can match one same file, share a migration slot, or share a branch. `GET reports/conflicts` (agent token) and `GET team/conflicts` (members) return `{ active, free, conflicts: [{ a, b, overlaps }] }`, per project like every other read. `free: true` means nothing is claimed or in review: the "queue free / main free" signal a merge orchestrator waits for. A claim's response carries the conflicts it is part of as a `warning`; it never blocks, because a human can see two `src/server/**` claims are fine. The CueLog shows a small "overlaps #1a2b3c4d" badge on each conflicting row (the reasons in its tooltip).

## (b) Work this queue (design only)

- **Hand out:** a member picks N reports in the CueLog and **Work this queue** assigns them round-robin to N agents (each its own token, `pull: false`). Each machine runs `shipcue-listen --on assigned -- <agent command>`; the agent claims with its scope, works in its own worktree/branch, and calls `submit_for_review` with the PR. shipcue runs nothing: listeners and agents do the work (Staying small, rule 4).
- **One board:** the CueLog's Board view already has Open / Claimed / In review / Fixed columns. The GitHub loop (report 919f5ca2, `github: { secret, liveCheck }`) moves a report to In review when a PR names it, keeps it in review with "Merged in #N, waiting to go live" after merge, and closes it once `liveCheck` sees the sha (the same `/api/version` check `ship.sh` does). So PR → review → merge → live needs no new state, only the swarm's reports filtered together.
- **The orchestrator stays outside:** rebasing, checks, migration renames and the merge stay in the swarm's scripts; they read `GET reports/conflicts` to order merges (non-overlapping first) and wait for `free` before a migration or deploy. The reviewer leaves its verdict as a note.

## v1 vs later

- **v1 (built):** scope on claim and `reports/:id/scope`, conflict detection with a tiny glob matcher, `reports/conflicts` + `team/conflicts`, the claim warning, MCP and listener plumbing, the CueLog badge. No new runtime dependency, no schema change.
- **Later:** the Work this queue button and round-robin assignment; a merge-order hint from conflicts; scope editing in the drawer; migration *ranges* (`1900..1999`) instead of exact slots; a "hold" flag (a claim that says "nobody merge until I'm done").

## Risks

- **Scopes are honest guesses.** An agent that declares `src/react/**` and then edits `src/server/handler.ts` gets no warning. Mitigation: the reviewer compares the PR's files with the declared scope (a later check against the PR diff).
- **Too many warnings** turn into noise ("everything touches handler.ts"). Warnings never block, and areas/paths are opt-in, so a team can declare only migrations and branches.
- **History-derived state** costs one events query per conflicts read. Fine at queue sizes (tens of active claims); a column can come later if it is not.
- **Scope creep toward a runner.** Anything that would start, schedule or babysit agents stays in the listener and the swarm scripts, not in shipcue.
