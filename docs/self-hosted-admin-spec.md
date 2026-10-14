# Self-Hosted Admin Spec

Oct 13, 2026 · @Jeffery

## Summary

A self-hostable admin page for shipcue: projects, members, invites, agent tokens, settings and the CueLog, running on the user's own Postgres. Most of it already exists as shipcue Cloud's dashboard. This spec moves that code into the package as `shipcue/admin` and makes Cloud its first consumer, so the hosted and self-hosted admin are one code path and never drift.

**Goals**

- Run the admin page against your own Postgres with no shipcue Cloud account.
- One code path: Cloud imports `shipcue/admin` instead of keeping its own copy.
- No new runtime dependency (README, Staying small, rule 5).
- Opt-in for anything that costs money or needs a third party: the hosted agent, email, OAuth.

**Non-goals**

- Hosting it for people. We ship a handler, a UI bundle and an example; shipcue never runs it (Staying small, rule 4).
- A new schema. Self-hosted uses `sql/cloud.sql` as it is.
- Replacing the app's own auth. If the app already has sign-in, the admin uses it.

## What exists

| Piece | Where | Generic? |
| --- | --- | --- |
| Admin API: projects, members, invites, agents, settings, digest | `createAdminHandler` in `src/admin/handler.ts`, exported as `shipcue/admin` (moved from `website/_src/cloud.mjs`) | Yes: a pg-style `db` plus `Request` → `Response` |
| Admin UI | `website/_src/app.jsx` | Yes: already built on `CueLogTable` from `src/react` |
| Schema | `sql/cloud.sql` (`cloud_projects`, `cloud_members`, `cloud_invites`, `cloud_agents`) | Yes |
| Wiring | `website/_src/cloud-api.mjs` | No: this is the Cloud-specific part |

What ties it to Cloud today, all in `cloud-api.mjs`:

- **Auth:** InsForge, through `insforgeAuth` (signUp, verify, refresh, OAuth).
- **Vercel:** `waitUntil` for background work; the digest runs on Vercel Cron with `CRON_SECRET`.
- **Cloud-only extras:** the `beta` email allowlist, the hosted OpenAI agent (`src/admin/hosted.ts`, off without `hosted`) and InsForge email.

## Design

### 1. `shipcue/admin` entry point

Done: `cloud.mjs` and `hosted.mjs` are ported to TypeScript under `src/admin/`, and `createAdminHandler` is exported from a new `./admin` entry in `package.json` `exports`, next to `./server`. `AdminAuth` needs only `current` and `refresh`; each sign-in method an adapter provides turns on its `{base}/auth` route.

```ts
import { createAdminHandler, passwordAuth } from 'shipcue/admin';

const admin = createAdminHandler({
  db: pool,                 // node-postgres Pool, PGlite, Neon: anything with query()
  auth: passwordAuth({ db: pool }),
  base: '/api/shipcue-admin',
});
```

`website/_src/cloud-api.mjs` then becomes a few lines that call `createAdminHandler` with the InsForge adapter, `beta`, `hosted`, `waitUntil` and InsForge email.

### 2. Auth adapters

The InsForge-shaped interface (signUp, signIn, verify, resend, refresh, current, oauthUrl, exchange) is too wide for most hosts. The core needs one function:

```ts
interface AdminAuth {
  /** The signed-in user, or null. */
  getUser(req: Request): Promise<{ id: string; email: string; name: string } | null>;
  /** Optional: sign-in, sign-up and sign-out routes under {base}/auth/... */
  routes?: (req: Request, parts: string[]) => Promise<Response | null>;
}
```

Adapters:

- **`getUser` only:** the app's own session, the same way `team.getMember` works. This is the main path.
- **`passwordAuth({ db })`:** scrypt hashes in a `shipcue_admin_users` table, through `node:crypto`. It provides `routes` for sign-in and sign-out.
- **`trustHeader('x-email')`:** for setups behind Cloudflare Access, Tailscale or oauth2-proxy.
- **`insforgeAuth(url)`:** stays as Cloud's adapter, with OAuth and email verification as its own routes.

### 3. One project by default

The schema stays the same. On first run, the handler creates one project if none exists, and the UI hides the project switcher when there is only one. Multi-project still works for anyone who creates more.

### 4. UI in two forms

- **Static bundle:** a prebuilt `dist/admin/` (HTML plus JS) that the handler serves at `${base}/admin`. The host app needs no React and no bundler. This is what makes the admin page self-hostable on its own.
- **Component:** `<ShipcueAdmin endpoint="/api/shipcue-admin" />` exported from `shipcue/react`, for apps that want it inside their own layout.

`app.jsx` already imports from `src/react`, so this is mostly moving code. The bundle is built by `tsup` alongside the rest of `dist`.

### 5. First run

`npx shipcue init --admin`:

1. Applies `sql/cloud.sql` (and `shipcue_admin_users` when `passwordAuth` is used).
2. Prints a one-time setup link that creates the first owner.

After that, people join by invite only. The `beta` allowlist becomes `allowSignup: false | string[]` (emails that may create projects), `false` by default.

### 6. Opt-in features

| Feature | Default self-hosted | How to turn it on |
| --- | --- | --- |
| Background work | An unawaited promise | `background: (work) => ...` (e.g. `waitUntil`) |
| Email (invites, digests) | Off; the UI hides email options | `sendEmail: (to, subject, html) => ...` |
| Digests | Not run | Call the exported `runDigests()` from any cron, like `checkLive()` today |
| Hosted triage agent | Off | `hosted: { ... }` with the user's own API key |
| OAuth | Off | An adapter that provides it, e.g. `insforgeAuth` |

### 7. Security

- `cookiePath` (currently `/api`) and `secureCookies` are options, since self-hosters mount at other paths and test on plain http.
- Write requests require `content-type: application/json` on top of `SameSite=Lax` cookies, to block CSRF.
- Agent tokens stay as stored today: shown once, kept only as a sha256 hash.
- The setup link is single-use and expires.

### 8. Example deployment

`examples/self-host/` with a `docker-compose.yml`: Postgres plus a `node:http` server mounting `createShipcueHandler` and `createAdminHandler`, the same way `examples/demo-server.mjs` does. It's an example, not a product we run.

## Status

Oct 13, 2026: `shipcue/admin` ships with `getUser` (plus `signInUrl`) as the main path and `page: true`, which serves the admin page from the handler (the script is its own chunk, loaded only when asked for). `examples/admin-demo.mjs` runs it with PGlite and no sign-in. Still to do: `passwordAuth`, `trustHeader`, one project made on first run, `init --admin`, and the `<ShipcueAdmin>` component.

## First version

The smallest useful version:

- `shipcue/admin` with `createAdminHandler`
- `getUser` and `passwordAuth`
- A single project created on first run
- The static bundle at `${base}/admin`
- `npx shipcue init --admin`
- Cloud switched over to import `shipcue/admin`

This covers members, invites, agent tokens, settings and the CueLog.

**Later:** `trustHeader`, the `<ShipcueAdmin>` component, multi-project UI for self-hosters, email, digests, the hosted agent, and the docker-compose example.

## Open question

Who is this mainly for?

- **People adding it to an existing app:** `getUser` plus the `<ShipcueAdmin>` component is enough to start. `passwordAuth` and the static bundle can wait.
- **People running it standalone next to their app:** the first version needs everything listed above.
