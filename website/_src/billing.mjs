// shipcue Cloud billing: the plans on /cloud, their limits, and Stripe Checkout to pay for one.
// Everything here is off unless switched on, so the free beta runs as before:
//   - limits apply only once CLOUD_BILLING_ENFORCED=1 or CLOUD_BETA_ENDS_AT has passed (until then every
//     account counts as Team);
//   - Checkout, the Customer Portal and the webhook exist only with STRIPE_SECRET_KEY and CLOUD_BILLING_ENABLED=1.
// See docs/cloud-billing.md.
import PLAN_DATA from './plans.json' with { type: 'json' };

/** The plans, as plans.json lists them (the one place their prices and limits live). null limits are unlimited. */
export const PLANS = PLAN_DATA.plans.map((p) => Object.freeze({ ...p, limits: Object.freeze({ ...p.limits }) }));
export const BETA_PLAN = PLAN_DATA.betaPlan;
export const planById = (id) => PLANS.find((p) => p.id === id) ?? null;

/** The things a plan limits, and how its messages name them. */
export const LIMITS = Object.freeze({
  projects: { one: 'project', many: 'projects' },
  agentTokens: { one: 'agent token', many: 'agent tokens' },
  people: { one: 'person', many: 'people' },
  hostedTriagesPerDay: { one: 'hosted triage a day', many: 'hosted triages a day' },
});

/** Subscription statuses that keep a plan's limits (past_due: Stripe is still retrying the card). */
export const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
export const UPGRADE_PATH = '/cloud';

const on = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/** Whether limits apply at `now`: CLOUD_BILLING_ENFORCED, or CLOUD_BETA_ENDS_AT (an ISO date) has passed. */
export function enforcedAt(env, now = new Date()) {
  if (on(env.CLOUD_BILLING_ENFORCED)) return true;
  const ends = env.CLOUD_BETA_ENDS_AT ? Date.parse(env.CLOUD_BETA_ENDS_AT) : NaN;
  return Number.isFinite(ends) && now.getTime() >= ends;
}

/** Whether Checkout, the portal and the webhook are on: a Stripe key and CLOUD_BILLING_ENABLED=1, both. */
export const billingEnabled = (env) => !!env.STRIPE_SECRET_KEY && on(env.CLOUD_BILLING_ENABLED);

/** Each plan's Stripe price id, from the env var plans.json names for it. Missing ones are left out. */
export function pricesFromEnv(env) {
  const out = {};
  for (const p of PLANS) if (env[p.priceEnv]) out[p.id] = String(env[p.priceEnv]).trim();
  return out;
}

/**
 * The Cloud handler's `billing` option from the environment. `makeStripe(key)` builds the Stripe client and is
 * only called when billing is enabled. Returns null when neither enforcement nor Checkout can ever turn on.
 */
export function billingFromEnv(env = process.env, makeStripe) {
  const enabled = billingEnabled(env);
  if (!enabled && !on(env.CLOUD_BILLING_ENFORCED) && !env.CLOUD_BETA_ENDS_AT) return null;
  return {
    enabled,
    enforced: (now) => enforcedAt(env, now),
    stripe: enabled ? makeStripe(env.STRIPE_SECRET_KEY) : null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    prices: pricesFromEnv(env),
  };
}

const describeLimit = (n, thing) => `${n} ${n === 1 ? LIMITS[thing].one : LIMITS[thing].many}`;

/** The 402 text for going over a limit; `plan` null means no plan (enforced, nothing paid for). */
export function limitMessage(plan, thing) {
  if (!plan) return `Your account has no plan now that the free beta has ended, so it cannot add ${LIMITS[thing].many}; choose a plan at ${UPGRADE_PATH}.`;
  return `Your ${plan.name} plan allows ${describeLimit(plan.limits[thing], thing)}; upgrade at ${UPGRADE_PATH}.`;
}

/** Null when `used + adding` fits the plan, else { status: 402, error }. Unlimited (null) always fits. */
export function checkLimit(plan, thing, used, adding = 1) {
  if (!(thing in LIMITS)) throw new Error(`Unknown limit: ${thing}`);
  const max = plan ? plan.limits[thing] : 0;
  if (max === null || used + adding <= max) return null;
  return { status: 402, error: limitMessage(plan, thing) };
}

/**
 * The plan whose limits apply to an account. Before enforcement every account counts as the beta plan (Team);
 * after, it is the plan its subscription pays for while the subscription is active, else none (null).
 */
export function effectivePlan(account, enforced) {
  if (!enforced) return planById(BETA_PLAN);
  if (account?.plan && ACTIVE_STATUSES.has(account.status)) return planById(account.plan);
  return null;
}

/** The plan id a Stripe price id belongs to, by the env's price ids. */
export function planForPrice(priceId, prices) {
  return Object.entries(prices).find(([, id]) => id === priceId)?.[0] ?? null;
}

/** The account state a Stripe subscription describes. current_period_end lives on its items in current API versions. */
export function subscriptionState(sub, prices) {
  const items = sub?.items?.data ?? [];
  const priceId = items[0]?.price?.id ?? null;
  const ends = items.map((i) => i.current_period_end).filter(Number.isFinite);
  const end = ends.length ? Math.max(...ends) : Number.isFinite(sub?.current_period_end) ? sub.current_period_end : null;
  return {
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
    subscriptionId: sub.id,
    plan: planForPrice(priceId, prices),
    status: sub.status,
    currentPeriodEnd: end === null ? null : new Date(end * 1000),
  };
}

/**
 * The next account state after a Stripe change (pure; the plan-state machine). An event older than the one the
 * state came from is ignored, and so is a deletion of a subscription the account has already moved on from.
 * @param {null | { plan, status, customerId, subscriptionId, currentPeriodEnd, eventAt }} prev
 * @param {{ at: Date, deleted?: boolean, plan, status, customerId, subscriptionId, currentPeriodEnd }} change
 */
export function nextAccountState(prev, change) {
  if (prev?.eventAt && change.at < prev.eventAt) return prev;
  if (change.deleted && prev?.subscriptionId && prev.subscriptionId !== change.subscriptionId) return prev;
  return {
    customerId: change.customerId ?? prev?.customerId ?? null,
    subscriptionId: change.subscriptionId,
    plan: change.deleted ? null : change.plan,
    status: change.deleted ? 'canceled' : change.status,
    currentPeriodEnd: change.currentPeriodEnd ?? null,
    eventAt: change.at,
  };
}

// A label for Checkout Sessions in Stripe's Dashboard (integration_identifier).
const INTEGRATION_ID = 'shipcue_cloud_plans_qhvzkmtw';

/**
 * Billing for the Cloud handler: reading an account's plan and usage, checking limits, and the
 * /billing routes (Checkout, Customer Portal, webhook). `config` is billingFromEnv's result, or null for off.
 * @param {{ q: (text: string, params?: unknown[]) => Promise<any[]>, config: ReturnType<typeof billingFromEnv>,
 *   json: Function, fail: Function, appPath: string, now?: () => Date }} o
 */
export function createBilling(o) {
  const { q, json, fail } = o;
  const config = o.config ?? null;
  const now = o.now ?? (() => new Date());
  const enabled = !!(config?.enabled && config.stripe);
  const isEnforced = () => !!config?.enforced(now());

  const accountRow = async (userId) => (await q(`SELECT * FROM cloud_accounts WHERE user_id = $1`, [userId]))[0] ?? null;
  const asState = (row) =>
    row && {
      plan: row.plan,
      status: row.status,
      customerId: row.stripe_customer_id,
      subscriptionId: row.stripe_subscription_id,
      currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
      eventAt: row.billing_event_at ? new Date(row.billing_event_at) : null,
    };

  /** The plan whose limits apply to this account now (see effectivePlan). */
  const planOf = async (userId) => (isEnforced() ? effectivePlan(await accountRow(userId), true) : effectivePlan(null, false));

  /** Everyone on, or invited to, an account's projects, by email. */
  const PEOPLE = `SELECT lower(m.email) AS email FROM cloud_members m JOIN cloud_projects p ON p.id = m.project_id AND NOT p.is_deleted
                   WHERE p.created_by = $1 AND NOT m.is_deleted
                  UNION
                  SELECT lower(i.email) FROM cloud_invites i JOIN cloud_projects p ON p.id = i.project_id AND NOT p.is_deleted
                   WHERE p.created_by = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL`;
  const count = async (text, params) => Number((await q(text, params))[0].n);
  const usage = {
    projects: (userId) => count(`SELECT count(*)::int AS n FROM cloud_projects WHERE created_by = $1 AND NOT is_deleted`, [userId]),
    agentTokens: (userId) =>
      count(
        `SELECT count(*)::int AS n FROM cloud_agents a JOIN cloud_projects p ON p.id = a.project_id AND NOT p.is_deleted
          WHERE p.created_by = $1 AND a.revoked_at IS NULL AND NOT a.hosted`,
        [userId],
      ),
    /** Everyone on, or invited to, the account's projects, each counted once by email. */
    people: (userId) => count(`SELECT count(*)::int AS n FROM (${PEOPLE}) x`, [userId]),
    hostedTriagesPerDay: (userId) =>
      count(
        `SELECT count(*)::int AS n FROM shipcue_report_events e
           JOIN cloud_agents a ON a.hosted AND a.project_id = e.project_id AND e.actor_id = a.id::text
           JOIN cloud_projects p ON p.id = a.project_id
          WHERE p.created_by = $1 AND e.action = 'note' AND e.at > now() - interval '1 day'`,
        [userId],
      ),
  };

  /**
   * Null when the account (a user id: who created the project) may add one more `thing`, else a 402 Response.
   * Off (always null, no queries) until enforcement is on. For people, pass the email being added: someone
   * already on another of the account's projects does not count twice.
   */
  async function check(userId, thing, email) {
    if (!isEnforced()) return null;
    const plan = await planOf(userId);
    if (thing === 'people' && email) {
      const known = await q(`SELECT 1 FROM (${PEOPLE}) x WHERE email = lower($2) LIMIT 1`, [userId, email]);
      if (known.length) return null;
    }
    const over = checkLimit(plan, thing, await usage[thing](userId));
    return over ? fail(over.error, over.status) : null;
  }

  /**
   * The hosted agent's daily cap for a project's account once enforcement is on: the plan's triages a day,
   * counted over all the account's projects. Null while enforcement is off (the server's own per-project cap applies).
   */
  async function triageLimit(userId) {
    if (!isEnforced()) return null;
    const plan = await planOf(userId);
    return {
      dailyLimit: plan ? plan.limits.hostedTriagesPerDay ?? Infinity : 0,
      usedToday: () => usage.hostedTriagesPerDay(userId),
      note: `The hosted agent did not look at this one. ${limitMessage(plan, 'hostedTriagesPerDay')}`,
    };
  }

  const publicPlans = () =>
    PLANS.map((p) => ({ id: p.id, name: p.name, price: p.price, blurb: p.blurb, pick: !!p.pick, limits: p.limits, available: !!config?.prices?.[p.id] }));

  /** The signed-in account's plan, usage and limits, for the dashboard's Plan section. */
  async function status(user) {
    const row = await accountRow(user.id);
    const enforced = isEnforced();
    const plan = enforced ? effectivePlan(row, true) : effectivePlan(null, false);
    const used = {};
    for (const thing of Object.keys(LIMITS)) used[thing] = await usage[thing](user.id);
    return json({
      enabled,
      enforced,
      beta: !enforced,
      plan: plan ? { id: plan.id, name: plan.name, limits: plan.limits } : null,
      subscription: row?.stripe_subscription_id
        ? { plan: row.plan, status: row.status, active: ACTIVE_STATUSES.has(row.status), currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null }
        : null,
      canManage: !!row?.stripe_customer_id,
      usage: used,
      plans: publicPlans(),
    });
  }

  async function ensureAccount(user) {
    await q(`INSERT INTO cloud_accounts (user_id, email) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [user.id, user.email]);
    return accountRow(user.id);
  }

  const appUrl = (req, query) => `${new URL(req.url).origin}${o.appPath}${query}`;

  async function checkout(req, user, b) {
    const plan = planById(b.plan);
    if (!plan) return fail(`Pick a plan: ${PLANS.map((p) => p.id).join(', ')}.`);
    const price = config.prices[plan.id];
    if (!price) return fail(`The ${plan.name} plan is not on sale yet.`, 409);
    let acct = await ensureAccount(user);
    if (acct.stripe_subscription_id && ACTIVE_STATUSES.has(acct.status)) return fail('You already have a plan. Change it with Manage billing.', 409);
    if (!acct.stripe_customer_id) {
      // Keyed per user, so two clicks at once make one customer.
      const customer = await config.stripe.customers.create(
        { email: user.email, metadata: { shipcue_user_id: user.id } },
        { idempotencyKey: `shipcue-cloud-customer-${user.id}` },
      );
      await q(`UPDATE cloud_accounts SET stripe_customer_id = $2, updated_at = now() WHERE user_id = $1 AND stripe_customer_id IS NULL`, [user.id, customer.id]);
      acct = await accountRow(user.id);
    }
    const session = await config.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: acct.stripe_customer_id,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      success_url: appUrl(req, '?billing=success&session_id={CHECKOUT_SESSION_ID}'),
      cancel_url: appUrl(req, '?billing=cancel'),
      metadata: { shipcue_user_id: user.id, plan: plan.id },
      subscription_data: { metadata: { shipcue_user_id: user.id, plan: plan.id } },
      integration_identifier: INTEGRATION_ID,
    });
    return json({ url: session.url });
  }

  async function portal(req, user) {
    const acct = await accountRow(user.id);
    if (!acct?.stripe_customer_id) return fail('There is no billing to manage yet. Pick a plan first.', 409);
    const session = await config.stripe.billingPortal.sessions.create({ customer: acct.stripe_customer_id, return_url: appUrl(req, '') });
    return json({ url: session.url });
  }

  /** Saves a subscription's state for the account it belongs to, through nextAccountState. */
  async function applySubscription(userId, sub, at, deleted = false) {
    const change = { ...subscriptionState(sub, config.prices), at, deleted };
    if (!userId) {
      userId = (await q(`SELECT user_id FROM cloud_accounts WHERE stripe_customer_id = $1`, [change.customerId]))[0]?.user_id ?? sub.metadata?.shipcue_user_id ?? null;
    }
    if (!userId) return;
    await q(`INSERT INTO cloud_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    const prev = asState(await accountRow(userId));
    const next = nextAccountState(prev, change);
    if (next === prev) return;
    await q(
      `UPDATE cloud_accounts SET plan = $2, status = $3, stripe_customer_id = $4, stripe_subscription_id = $5, current_period_end = $6,
              billing_event_at = $7, updated_at = now() WHERE user_id = $1`,
      [userId, next.plan, next.status, next.customerId, next.subscriptionId, next.currentPeriodEnd, next.eventAt],
    );
  }

  async function handleEvent(event) {
    const at = new Date(event.created * 1000);
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (obj.mode !== 'subscription' || !obj.subscription) return;
      const userId = obj.client_reference_id ?? obj.metadata?.shipcue_user_id ?? null;
      const sub = await config.stripe.subscriptions.retrieve(typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id);
      return applySubscription(userId, sub, at);
    }
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') return applySubscription(null, obj, at);
    if (event.type === 'customer.subscription.deleted') return applySubscription(null, obj, at, true);
  }

  /** POST /billing/webhook: Stripe's signed events, each handled once. */
  async function webhook(req) {
    const signature = req.headers.get('stripe-signature');
    if (!config.webhookSecret || !signature) return fail('Missing signature.', 400);
    const raw = await req.text();
    let event;
    try {
      event = await config.stripe.webhooks.constructEventAsync(raw, signature, config.webhookSecret);
    } catch {
      return fail('Bad signature.', 400);
    }
    const fresh = await q(`INSERT INTO cloud_billing_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`, [event.id, event.type]);
    if (!fresh.length) return json({ received: true, duplicate: true });
    try {
      await handleEvent(event);
    } catch (err) {
      // Not handled: forget it so Stripe's retry runs it again.
      await q(`DELETE FROM cloud_billing_events WHERE id = $1`, [event.id]);
      console.error('shipcue cloud: billing webhook failed', event.type, err instanceof Error ? err.message : err);
      return fail('Could not handle that event.', 500);
    }
    return json({ received: true });
  }

  /**
   * The /billing routes, or null to fall through (billing off: the Cloud answers exactly as before).
   * `signedIn` resolves the session for the routes that need one.
   */
  async function routes(req, rest, signedIn) {
    if (!enabled) return null;
    const [action, ...more] = rest;
    if (more.length) return null;
    if (action === 'webhook' && req.method === 'POST') return webhook(req);
    if (action === 'plans' && req.method === 'GET') return json({ plans: publicPlans(), enforced: isEnforced() });
    const s = await signedIn();
    if (!s) return fail('Sign in first.', 401);
    if (!action && req.method === 'GET') return status(s.user);
    if (req.method !== 'POST') return null;
    if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return fail('Send JSON.', 415);
    let b = {};
    try {
      b = (await req.json()) ?? {};
    } catch {
      // An empty body is fine for the portal.
    }
    if (action === 'checkout') return checkout(req, s.user, b);
    if (action === 'portal') return portal(req, s.user);
    return null;
  }

  return { enabled, isEnforced, planOf, usage, check, triageLimit, routes, status };
}
