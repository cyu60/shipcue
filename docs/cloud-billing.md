# shipcue Cloud billing

Plan limits and Stripe Checkout for shipcue Cloud (`/api/cloud`, the `/app` dashboard and the `/cloud` page).
All of it ships **off**: with none of the variables below set, the Cloud behaves exactly as the free beta does
today, and the plan buttons on `/cloud` read "Free during beta".

## The plans

`website/_src/plans.json` is the only place the plans live. `website/_src/billing.mjs` enforces it,
`website/build.py` renders the `/cloud` cards from it, and the dashboard's Plan section reads it through the API.
`null` means unlimited.

| Plan | Price | Projects | Agent tokens | People | Hosted triages a day |
| --- | --- | --- | --- | --- | --- |
| Solo | $10/mo | 2 | 5 | 1 | 10 |
| Builder | $25/mo | 10 | 25 | 3 | 50 |
| Team | $50/mo | unlimited | unlimited | 10 | 200 |

What counts, per account (the InsForge user who created the project, `cloud_projects.created_by`):

- **Projects**: the projects they created that are not deleted.
- **Agent tokens**: the connected agents (not the hosted agent) over all their projects.
- **People**: everyone on, or invited to, any of their projects, counted once by email (the owner included,
  so Solo's 1 is "just you").
- **Hosted triages a day**: notes the hosted agent left in the last 24 hours over all their projects. At the
  cap it leaves a note saying so instead of triaging.

Over a limit, the API answers `402` with `Your <plan> plan allows N <thing>; upgrade at /cloud.` Nothing that
already exists is removed or blocked; only adding more is.

## Environment variables

| Variable | What it does |
| --- | --- |
| `CLOUD_BILLING_ENFORCED` | `1` turns the limits on now. Unset or `0`: off. |
| `CLOUD_BETA_ENDS_AT` | An ISO date (`2027-01-01T00:00:00Z`). The limits turn on by themselves once it has passed. |
| `CLOUD_BILLING_ENABLED` | `1` turns on Checkout, the Customer Portal, the webhook, the dashboard's Plan section and the `/cloud` plan buttons. Needs `STRIPE_SECRET_KEY` too. |
| `STRIPE_SECRET_KEY` | The Stripe API key. Prefer a [restricted key](https://docs.stripe.com/keys#limit-access) (`rk_live_…`) with write access to Customers, Checkout Sessions, Customer Portal and read access to Subscriptions. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret (`whsec_…`) of the webhook endpoint below. Without it every webhook call is refused. |
| `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_BUILDER`, `STRIPE_PRICE_TEAM` | Each plan's monthly Price id (`price_…`). A plan without one shows but cannot be bought. |

Until enforcement is on, every account counts as **Team** (the beta plan), whatever it pays for. Once it is
on, an account's plan is the one its subscription pays for while the subscription is `active`, `trialing` or
`past_due`; an account with no such subscription can add nothing new until it picks a plan.

Turn Checkout on before enforcement (or at the same time), so people can pay before the limits apply.

## Going live

1. **Create the live Products and Prices** (monthly, USD). In the Stripe Dashboard: Product catalog → Add
   product, once per plan, with a recurring monthly price. Or with the Stripe CLI against live mode:

   ```sh
   stripe products create --live --name "shipcue Cloud Solo" -d "metadata[shipcue_plan]=solo"
   stripe prices create --live --product prod_… --currency usd --unit-amount 1000 -d "recurring[interval]=month" -d "metadata[shipcue_plan]=solo"
   # Builder: --unit-amount 2500, Team: --unit-amount 5000
   ```

   Put the three `price_…` ids in `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_BUILDER` and `STRIPE_PRICE_TEAM` on Vercel.

2. **Point a webhook at the Cloud.** Dashboard → Developers → Webhooks → Add endpoint:
   `https://shipcue.ibuildathing.com/api/cloud/billing/webhook`, with the events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`. To try it locally: `stripe listen --forward-to localhost:3000/api/cloud/billing/webhook`.

3. **Turn on the Customer Portal** (Settings → Billing → Customer portal) so Manage billing can switch plans,
   update cards and cancel. Add the three products to its plan-switching list.

4. **Run the schema**: `sql/cloud.sql` is safe to run again; it adds `cloud_accounts` and `cloud_billing_events`.

5. Set `STRIPE_SECRET_KEY` and `CLOUD_BILLING_ENABLED=1` on Vercel and redeploy. The `/cloud` buttons become
   "Choose Solo" and so on, and the dashboard shows the Plan section. Nobody is limited yet.

6. When the beta ends, set `CLOUD_BILLING_ENFORCED=1` (or set `CLOUD_BETA_ENDS_AT` ahead of time).

## The routes

All under `/api/cloud/billing`, and all answer as if they did not exist unless Checkout is on.

| Route | |
| --- | --- |
| `GET /billing` | The signed-in account's plan, subscription, usage and the plans. |
| `GET /billing/plans` | The plans, for the `/cloud` page. No sign-in. |
| `POST /billing/checkout` `{ "plan": "solo" }` | A subscription Checkout Session for the signed-in account; returns `{ url }`. Back to `/app/?billing=success` or `?billing=cancel`. |
| `POST /billing/portal` | A Customer Portal session; returns `{ url }`. |
| `POST /billing/webhook` | Stripe's events, signature-checked with `STRIPE_WEBHOOK_SECRET`. Each event id is handled once (`cloud_billing_events`); an event older than the account's last one never undoes it. |

The plan is set only by the webhook, never by the success page.
