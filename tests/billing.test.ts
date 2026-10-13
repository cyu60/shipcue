// shipcue Cloud billing: the plan table, limits (enforced and gated off), Stripe Checkout, the portal and
// the webhook. Stripe's API is mocked; webhook signatures are real (the SDK's own signing helper).
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Stripe from 'stripe';
// @ts-expect-error -- plain JS module for the site's function
import { createCloudHandler } from '../website/_src/cloud.mjs';
import {
  PLANS,
  BETA_PLAN,
  LIMITS,
  planById,
  checkLimit,
  limitMessage,
  effectivePlan,
  enforcedAt,
  billingEnabled,
  billingFromEnv,
  pricesFromEnv,
  planForPrice,
  subscriptionState,
  nextAccountState,
  createBilling,
  // @ts-expect-error -- plain JS module for the site's function
} from '../website/_src/billing.mjs';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cloudSql = readFileSync(new URL('../sql/cloud.sql', import.meta.url), 'utf8');
const plansJson = readFileSync(new URL('../website/_src/plans.json', import.meta.url), 'utf8');
const BASE = 'https://shipcue.example.com/api/cloud';
const PRICES = { solo: 'price_solo_test', builder: 'price_builder_test', team: 'price_team_test' };
const WHSEC = 'whsec_test_secret';
const realStripe = new Stripe('sk_test_not_a_real_key');

/** InsForge auth stand-in: access token "at:<email>". */
function fakeAuth() {
  const users = new Map<string, string>();
  const tokens = (email: string) => ({ accessToken: `at:${email}`, refreshToken: `rt:${email}`, user: { id: users.get(email)!, email } });
  return {
    async signUp(email: string) {
      users.set(email, crypto.randomUUID());
      return { tokens: tokens(email), needsVerification: false };
    },
    async current(token: string) {
      const email = token.slice(3);
      return users.has(email) ? { id: users.get(email)!, email } : null;
    },
    async refresh() {
      return null;
    },
    idOf: (email: string) => users.get(email)!,
  };
}

function mockStripe() {
  return {
    customers: { create: vi.fn(async (p: { email: string }) => ({ id: `cus_${p.email.split('@')[0]}` })) },
    checkout: { sessions: { create: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })) } },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/test_1' })) } },
    subscriptions: { retrieve: vi.fn(async (id: string) => subscription(id, 'price_solo_test')) },
    webhooks: realStripe.webhooks,
  };
}

const subscription = (id: string, price: string, status = 'active', customer = 'cus_ada', end = 1_900_000_000) => ({
  id,
  object: 'subscription',
  customer,
  status,
  metadata: {},
  items: { data: [{ price: { id: price }, current_period_end: end }] },
});

let db: PGlite;
let auth: ReturnType<typeof fakeAuth>;
let handle: (req: Request) => Promise<Response>;
let stripe: ReturnType<typeof mockStripe>;
let enforced: boolean;

function makeHandler(billing: unknown, extra: Record<string, unknown> = {}) {
  handle = createCloudHandler({ db: { query: (t: string, p?: unknown[]) => db.query(t, p) }, auth, beta: ['ada@example.com', 'cy@example.com'], secureCookies: false, billing, ...extra });
}
/** Billing as billingFromEnv makes it, with a mocked Stripe and a switchable enforcement flag. */
const billingConfig = (o: { enabled?: boolean } = {}) => ({
  enabled: o.enabled ?? true,
  enforced: () => enforced,
  stripe: o.enabled === false ? null : stripe,
  webhookSecret: WHSEC,
  prices: PRICES,
});

beforeEach(async () => {
  db = new PGlite();
  await db.exec(schema);
  await db.exec(cloudSql);
  auth = fakeAuth();
  stripe = mockStripe();
  enforced = false;
}, 60_000);

async function call(method: string, path: string, opts: { as?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = opts.body !== undefined ? { 'content-type': 'application/json' } : {};
  if (opts.as) headers.cookie = `sc_at=${encodeURIComponent(`at:${opts.as}`)}`;
  const res = await handle(new Request(BASE + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }));
  return { res, data: await res.clone().json().catch(() => null) };
}
const signUp = (email: string) => auth.signUp(email);
async function setPlan(email: string, plan: string | null, status = 'active') {
  await db.query(`INSERT INTO cloud_accounts (user_id, plan, status) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET plan = $2, status = $3`, [auth.idOf(email), plan, status]);
}
async function newProject(as = 'ada@example.com', name = 'App') {
  return call('POST', '/projects', { as, body: { name } });
}
function signed(event: Record<string, unknown>, secret = WHSEC) {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request(`${BASE}/billing/webhook`, { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
}
let eventSeq = 0;
const event = (type: string, object: Record<string, unknown>, created = 1_800_000_000 + eventSeq) => ({
  id: `evt_${++eventSeq}`,
  object: 'event',
  type,
  created,
  data: { object },
});

describe('the plan table', () => {
  it('has the three plans approved on 2026-10-13, cheapest first', () => {
    expect(PLANS.map((p: { id: string; name: string; price: number }) => [p.id, p.name, p.price])).toEqual([
      ['solo', 'Solo', 10],
      ['builder', 'Builder', 25],
      ['team', 'Team', 50],
    ]);
    expect(planById('solo').limits).toEqual({ projects: 2, agentTokens: 5, people: 1, hostedTriagesPerDay: 10 });
    expect(planById('builder').limits).toEqual({ projects: 10, agentTokens: 25, people: 3, hostedTriagesPerDay: 50 });
    expect(planById('team').limits).toEqual({ projects: null, agentTokens: null, people: 10, hostedTriagesPerDay: 200 });
    expect(planById('nope')).toBeNull();
    expect(BETA_PLAN).toBe('team');
    expect(Object.keys(LIMITS)).toEqual(Object.keys(planById('solo').limits));
  });

  it('takes Stripe price ids from env, never from the table', () => {
    expect(plansJson).not.toMatch(/price_[A-Za-z0-9]/);
    expect(PLANS.map((p: { priceEnv: string }) => p.priceEnv)).toEqual(['STRIPE_PRICE_SOLO', 'STRIPE_PRICE_BUILDER', 'STRIPE_PRICE_TEAM']);
    expect(pricesFromEnv({ STRIPE_PRICE_SOLO: 'price_a', STRIPE_PRICE_TEAM: ' price_c ' })).toEqual({ solo: 'price_a', team: 'price_c' });
    expect(planForPrice('price_builder_test', PRICES)).toBe('builder');
    expect(planForPrice('price_unknown', PRICES)).toBeNull();
  });

  it('is what the /cloud page shows', () => {
    const page = readFileSync(new URL('../website/cloud/index.html', import.meta.url), 'utf8');
    for (const p of PLANS) {
      expect(page).toContain(`<h3>${p.name}</h3><p class="price">$${p.price}<span>/month</span>`);
      expect(page).toContain(`data-plan="${p.id}"`);
    }
    expect(page).toContain('2 projects');
    expect(page).toContain('200 hosted triages a day');
    expect(page.match(/>Free during beta</g)?.length).toBe(PLANS.length);
  });
});

describe('the flags', () => {
  it('enforcement is off by default, on with CLOUD_BILLING_ENFORCED or once CLOUD_BETA_ENDS_AT has passed', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(enforcedAt({}, now)).toBe(false);
    expect(enforcedAt({ CLOUD_BILLING_ENFORCED: '0' }, now)).toBe(false);
    expect(enforcedAt({ CLOUD_BILLING_ENFORCED: '1' }, now)).toBe(true);
    expect(enforcedAt({ CLOUD_BETA_ENDS_AT: '2027-01-01T00:00:00Z' }, now)).toBe(false);
    expect(enforcedAt({ CLOUD_BETA_ENDS_AT: '2026-10-01' }, now)).toBe(true);
    expect(enforcedAt({ CLOUD_BETA_ENDS_AT: 'soon' }, now)).toBe(false);
  });

  it('Checkout needs both STRIPE_SECRET_KEY and CLOUD_BILLING_ENABLED=1', () => {
    expect(billingEnabled({})).toBe(false);
    expect(billingEnabled({ STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
    expect(billingEnabled({ CLOUD_BILLING_ENABLED: '1' })).toBe(false);
    expect(billingEnabled({ STRIPE_SECRET_KEY: 'sk_test_x', CLOUD_BILLING_ENABLED: '1' })).toBe(true);
  });

  it('billingFromEnv is null with nothing set, and never builds a Stripe client while Checkout is off', () => {
    const make = vi.fn(() => stripe);
    expect(billingFromEnv({}, make)).toBeNull();
    expect(billingFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_SOLO: 'price_a' }, make)).toBeNull();
    const enforcedOnly = billingFromEnv({ CLOUD_BILLING_ENFORCED: '1' }, make);
    expect(enforcedOnly).toMatchObject({ enabled: false, stripe: null });
    expect(make).not.toHaveBeenCalled();
    const on = billingFromEnv({ STRIPE_SECRET_KEY: 'sk_test_x', CLOUD_BILLING_ENABLED: '1', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_BUILDER: 'price_b' }, make);
    expect(make).toHaveBeenCalledWith('sk_test_x');
    expect(on).toMatchObject({ enabled: true, webhookSecret: WHSEC, prices: { builder: 'price_b' } });
    expect(on.enforced(new Date())).toBe(false);
  });
});

describe('limit checks', () => {
  it('say what the plan allows and where to upgrade', () => {
    const solo = planById('solo');
    expect(checkLimit(solo, 'projects', 1)).toBeNull();
    expect(checkLimit(solo, 'projects', 2)).toEqual({ status: 402, error: 'Your Solo plan allows 2 projects; upgrade at /cloud.' });
    expect(checkLimit(solo, 'agentTokens', 5)?.error).toBe('Your Solo plan allows 5 agent tokens; upgrade at /cloud.');
    expect(checkLimit(solo, 'people', 1)?.error).toBe('Your Solo plan allows 1 person; upgrade at /cloud.');
    expect(checkLimit(solo, 'hostedTriagesPerDay', 10)?.error).toBe('Your Solo plan allows 10 hosted triages a day; upgrade at /cloud.');
    expect(checkLimit(planById('team'), 'projects', 10_000)).toBeNull();
    expect(checkLimit(planById('team'), 'people', 10)?.error).toBe('Your Team plan allows 10 people; upgrade at /cloud.');
    expect(checkLimit(null, 'projects', 0)?.error).toMatch(/no plan.*choose a plan at \/cloud/);
    expect(() => checkLimit(solo, 'machines', 0)).toThrow();
  });

  it('the effective plan is Team during the beta, then whatever an active subscription pays for', () => {
    expect(effectivePlan(null, false).id).toBe('team');
    expect(effectivePlan({ plan: 'solo', status: 'active' }, false).id).toBe('team');
    expect(effectivePlan({ plan: 'solo', status: 'active' }, true).id).toBe('solo');
    expect(effectivePlan({ plan: 'builder', status: 'past_due' }, true).id).toBe('builder');
    expect(effectivePlan({ plan: 'builder', status: 'canceled' }, true)).toBeNull();
    expect(effectivePlan(null, true)).toBeNull();
    expect(limitMessage(null, 'agentTokens')).toMatch(/agent tokens/);
  });
});

describe('limits in the Cloud API', () => {
  beforeEach(async () => {
    makeHandler(billingConfig({ enabled: false }));
    await signUp('ada@example.com');
  });

  it('projects: enforced, the third Solo project is a 402; gated off, it is made', async () => {
    await setPlan('ada@example.com', 'solo');
    enforced = true;
    expect((await newProject()).res.status).toBe(201);
    expect((await newProject()).res.status).toBe(201);
    const third = await newProject();
    expect(third.res.status).toBe(402);
    expect(third.data.error).toBe('Your Solo plan allows 2 projects; upgrade at /cloud.');
    enforced = false;
    expect((await newProject()).res.status).toBe(201);
  });

  it('projects: deleted ones do not count, and Team is unlimited', async () => {
    await setPlan('ada@example.com', 'solo');
    enforced = true;
    const a = await newProject();
    await newProject();
    await call('POST', `/projects/${a.data.project.id}/delete`, { as: 'ada@example.com', body: {} });
    expect((await newProject()).res.status).toBe(201);
    await setPlan('ada@example.com', 'team');
    for (let i = 0; i < 4; i++) expect((await newProject()).res.status).toBe(201);
  });

  it('agent tokens: counted over all the account’s projects', async () => {
    await setPlan('ada@example.com', 'solo');
    const one = (await newProject()).data.project.id;
    const two = (await newProject()).data.project.id;
    enforced = true;
    for (let i = 0; i < 5; i++) {
      const { res } = await call('POST', `/projects/${i % 2 ? one : two}/agents`, { as: 'ada@example.com', body: { name: `agent-${i}` } });
      expect(res.status).toBe(201);
    }
    const sixth = await call('POST', `/projects/${one}/agents`, { as: 'ada@example.com', body: { name: 'agent-6' } });
    expect(sixth.res.status).toBe(402);
    expect(sixth.data.error).toBe('Your Solo plan allows 5 agent tokens; upgrade at /cloud.');
    // Disconnecting one frees a token.
    const agent = (await db.query<{ id: string }>(`SELECT id FROM cloud_agents WHERE project_id = $1 LIMIT 1`, [one])).rows[0]!;
    await call('POST', `/projects/${one}/agents/${agent.id}/revoke`, { as: 'ada@example.com', body: {} });
    expect((await call('POST', `/projects/${one}/agents`, { as: 'ada@example.com', body: { name: 'agent-6' } })).res.status).toBe(201);
    enforced = false;
    expect((await call('POST', `/projects/${one}/agents`, { as: 'ada@example.com', body: { name: 'agent-7' } })).res.status).toBe(201);
  });

  it('people: Solo is just you; Builder is 3, each person counted once across projects', async () => {
    await setPlan('ada@example.com', 'solo');
    const one = (await newProject()).data.project.id;
    enforced = true;
    const solo = await call('POST', `/projects/${one}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com' } });
    expect(solo.res.status).toBe(402);
    expect(solo.data.error).toBe('Your Solo plan allows 1 person; upgrade at /cloud.');

    await setPlan('ada@example.com', 'builder');
    const two = (await newProject()).data.project.id;
    expect((await call('POST', `/projects/${one}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com' } })).res.status).toBe(201);
    expect((await call('POST', `/projects/${one}/invites`, { as: 'ada@example.com', body: { email: 'cy@example.com' } })).res.status).toBe(201);
    // Bob is already counted, so inviting him to the second project is free.
    expect((await call('POST', `/projects/${two}/invites`, { as: 'ada@example.com', body: { email: 'BOB@example.com' } })).res.status).toBe(201);
    const fourth = await call('POST', `/projects/${two}/invites`, { as: 'ada@example.com', body: { email: 'dee@example.com' } });
    expect(fourth.res.status).toBe(402);
    expect(fourth.data.error).toBe('Your Builder plan allows 3 people; upgrade at /cloud.');
    enforced = false;
    expect((await call('POST', `/projects/${two}/invites`, { as: 'ada@example.com', body: { email: 'dee@example.com' } })).res.status).toBe(201);
  });

  it('limits follow the account that created the project, not whoever is adding', async () => {
    await setPlan('ada@example.com', 'builder');
    const id = (await newProject()).data.project.id;
    await call('POST', `/projects/${id}/invites`, { as: 'ada@example.com', body: { email: 'bob@example.com', role: 'member' } });
    await signUp('bob@example.com');
    await call('GET', '/me', { as: 'bob@example.com' });
    enforced = true;
    // Bob has no plan of his own, but Ada's Builder plan covers his agent on her project.
    expect((await call('POST', `/projects/${id}/agents`, { as: 'bob@example.com', body: { name: 'bobs-agent' } })).res.status).toBe(201);
  });

  it('no plan after the beta: nothing new can be added, with a pointer to /cloud', async () => {
    const id = (await newProject()).data.project.id;
    enforced = true;
    const p = await newProject();
    expect(p.res.status).toBe(402);
    expect(p.data.error).toMatch(/no plan now that the free beta has ended.*\/cloud/);
    expect((await call('POST', `/projects/${id}/agents`, { as: 'ada@example.com', body: { name: 'x' } })).res.status).toBe(402);
    // What is already there keeps working.
    expect((await call('GET', `/projects/${id}`, { as: 'ada@example.com' })).res.status).toBe(200);
  });
});

describe('hosted triages a day', () => {
  async function hostedSetup(dailyLimit = 50) {
    const pending: Promise<unknown>[] = [];
    let openaiCalls = 0;
    const GOOD = { summary: 'Save does nothing.', area: 'other', priority: 'high', priorityReason: 'x', steps: [], missing: [], plan: ['Fix it'] };
    makeHandler(billingConfig({ enabled: false }), {
      hosted: {
        apiKey: 'sk-test',
        model: 'gpt-test',
        timeoutMs: 1000,
        dailyLimit,
        fetchImpl: async () => {
          openaiCalls++;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }));
        },
      },
      background: (w: Promise<unknown>) => pending.push(w),
    });
    await signUp('ada@example.com');
    const p = (await newProject()).data.project;
    await call('POST', `/projects/${p.id}/settings`, { as: 'ada@example.com', body: { hostedAgent: true, hostedAutoTriage: true } });
    const file = async (i: number) => {
      const form = new FormData();
      form.set('type', 'bug');
      form.set('description', `Save does nothing, take ${i}`);
      expect((await handle(new Request(`${BASE}/p/${p.publicKey}/reports`, { method: 'POST', body: form }))).status).toBe(201);
      while (pending.length) await Promise.all(pending.splice(0));
    };
    const notes = async () => (await db.query<{ text: string }>(`SELECT detail->>'text' AS text FROM shipcue_report_events WHERE action = 'note' ORDER BY seq`)).rows.map((r) => r.text);
    return { file, notes, calls: () => openaiCalls };
  }

  it('enforced: the Solo plan stops at 10 a day with the upgrade note', async () => {
    const h = await hostedSetup();
    await setPlan('ada@example.com', 'solo');
    enforced = true;
    for (let i = 0; i < 11; i++) await h.file(i);
    expect(h.calls()).toBe(10);
    const notes = await h.notes();
    expect(notes).toHaveLength(11);
    expect(notes[10]).toBe('The hosted agent did not look at this one. Your Solo plan allows 10 hosted triages a day; upgrade at /cloud.');
  });

  it('gated off: the server’s own per-project cap applies, as before', async () => {
    const h = await hostedSetup(12);
    await setPlan('ada@example.com', 'solo');
    for (let i = 0; i < 13; i++) await h.file(i);
    expect(h.calls()).toBe(12);
    expect((await h.notes())[12]).toMatch(/today's limit of 12 triages for this project/);
  });

  it('counts triages over all the account’s projects', async () => {
    makeHandler(billingConfig({ enabled: false }));
    await signUp('ada@example.com');
    const billing = createBilling({
      q: async (t: string, p?: unknown[]) => (await db.query(t, p)).rows,
      config: billingConfig({ enabled: false }),
      json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }),
      fail: (error: string, status = 400) => new Response(JSON.stringify({ error }), { status }),
      appPath: '/app/',
    });
    expect(await billing.triageLimit(auth.idOf('ada@example.com'))).toBeNull();
    const ada = auth.idOf('ada@example.com');
    for (const name of ['One', 'Two']) {
      const p = (await newProject('ada@example.com', name)).data.project;
      const [a] = (await db.query<{ id: string }>(`INSERT INTO cloud_agents (project_id, name, owner_user_id, owner_name, hosted) VALUES ($1, 'shipcue-agent', $2, 'ada', true) RETURNING id`, [p.id, ada])).rows;
      for (let i = 0; i < 3; i++) {
        await db.query(`INSERT INTO shipcue_report_events (report_id, project_id, action, actor_kind, actor_id) VALUES (gen_random_uuid(), $1, 'note', 'agent', $2)`, [p.id, a!.id]);
      }
      // Yesterday's notes and a person's notes do not count.
      await db.query(`INSERT INTO shipcue_report_events (report_id, project_id, action, actor_kind, actor_id, at) VALUES (gen_random_uuid(), $1, 'note', 'agent', $2, now() - interval '2 days')`, [p.id, a!.id]);
      await db.query(`INSERT INTO shipcue_report_events (report_id, project_id, action, actor_kind, actor_id) VALUES (gen_random_uuid(), $1, 'note', 'person', $2)`, [p.id, ada]);
    }
    enforced = true;
    await setPlan('ada@example.com', 'builder');
    const limit = await billing.triageLimit(ada);
    expect(limit.dailyLimit).toBe(50);
    expect(await limit.usedToday()).toBe(6);
  });
});

describe('Stripe Checkout and the portal', () => {
  beforeEach(async () => {
    makeHandler(billingConfig());
    await signUp('ada@example.com');
  });

  it('creates a subscription Checkout Session for the signed-in account, with a customer made once', async () => {
    const { res, data } = await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'builder' } });
    expect(res.status).toBe(200);
    expect(data.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const ada = auth.idOf('ada@example.com');
    expect(stripe.customers.create).toHaveBeenCalledWith({ email: 'ada@example.com', metadata: { shipcue_user_id: ada } }, { idempotencyKey: `shipcue-cloud-customer-${ada}` });
    const params = stripe.checkout.sessions.create.mock.calls[0]![0] as Record<string, any>;
    expect(params).toMatchObject({
      mode: 'subscription',
      customer: 'cus_ada',
      client_reference_id: ada,
      line_items: [{ price: 'price_builder_test', quantity: 1 }],
      success_url: 'https://shipcue.example.com/app/?billing=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://shipcue.example.com/app/?billing=cancel',
      metadata: { shipcue_user_id: ada, plan: 'builder' },
      subscription_data: { metadata: { shipcue_user_id: ada, plan: 'builder' } },
    });
    expect(params.integration_identifier).toMatch(/^shipcue_cloud_plans_[a-z]{8}$/);
    expect(params).not.toHaveProperty('payment_method_types');
    // A second Checkout reuses the customer.
    await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'solo' } });
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect((stripe.checkout.sessions.create.mock.calls[1]![0] as Record<string, any>).customer).toBe('cus_ada');
  });

  it('refuses unknown plans, plans without a price, signed-out callers and an account that already pays', async () => {
    expect((await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'gold' } })).res.status).toBe(400);
    expect((await call('POST', '/billing/checkout', { body: { plan: 'solo' } })).res.status).toBe(401);
    makeHandler({ ...billingConfig(), prices: { solo: 'price_solo_test' } });
    expect((await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'team' } })).res.status).toBe(409);
    await db.query(`INSERT INTO cloud_accounts (user_id, plan, status, stripe_customer_id, stripe_subscription_id) VALUES ($1, 'solo', 'active', 'cus_ada', 'sub_1')`, [auth.idOf('ada@example.com')]);
    const again = await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'solo' } });
    expect(again.res.status).toBe(409);
    expect(again.data.error).toMatch(/Manage billing/);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('opens the Customer Portal for an account with a Stripe customer', async () => {
    expect((await call('POST', '/billing/portal', { as: 'ada@example.com', body: {} })).res.status).toBe(409);
    await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'solo' } });
    const { res, data } = await call('POST', '/billing/portal', { as: 'ada@example.com', body: {} });
    expect(res.status).toBe(200);
    expect(data.url).toBe('https://billing.stripe.com/p/session/test_1');
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: 'cus_ada', return_url: 'https://shipcue.example.com/app/' });
  });

  it('shows the plan, usage and limits; /me says billing is on', async () => {
    await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'One' } });
    const { data: me } = await call('GET', '/me', { as: 'ada@example.com' });
    expect(me.billing).toEqual({ enabled: true, enforced: false });
    const { data } = await call('GET', '/billing', { as: 'ada@example.com' });
    expect(data).toMatchObject({ enabled: true, enforced: false, beta: true, plan: { id: 'team' }, subscription: null, canManage: false });
    expect(data.usage).toEqual({ projects: 1, agentTokens: 0, people: 1, hostedTriagesPerDay: 0 });
    expect(data.plans.map((p: { id: string; available: boolean }) => [p.id, p.available])).toEqual([['solo', true], ['builder', true], ['team', true]]);
    const { data: pub } = await call('GET', '/billing/plans');
    expect(pub.plans).toHaveLength(3);
  });
});

describe('the webhook', () => {
  beforeEach(async () => {
    makeHandler(billingConfig());
    await signUp('ada@example.com');
    await call('POST', '/billing/checkout', { as: 'ada@example.com', body: { plan: 'solo' } });
  });
  const account = async () => (await db.query<Record<string, any>>(`SELECT * FROM cloud_accounts WHERE user_id = $1`, [auth.idOf('ada@example.com')])).rows[0]!;
  const completed = () =>
    event('checkout.session.completed', { id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', client_reference_id: auth.idOf('ada@example.com'), customer: 'cus_ada', subscription: 'sub_1' });

  it('rejects a missing or wrong signature', async () => {
    const e = completed();
    const unsigned = await handle(new Request(`${BASE}/billing/webhook`, { method: 'POST', body: JSON.stringify(e), headers: { 'content-type': 'application/json' } }));
    expect(unsigned.status).toBe(400);
    expect((await handle(signed(e, 'whsec_wrong'))).status).toBe(400);
    // Signed, then tampered with.
    const req = signed(e);
    const forged = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ ...e, data: { object: { ...e.data.object, client_reference_id: 'someone-else' } } }) });
    expect((await handle(forged)).status).toBe(400);
    expect((await account()).plan).toBeNull();
  });

  it('checkout.session.completed sets the plan from the subscription, once per event', async () => {
    const e = completed();
    const res = await handle(signed(e));
    expect(res.status).toBe(200);
    expect(await account()).toMatchObject({ plan: 'solo', status: 'active', stripe_customer_id: 'cus_ada', stripe_subscription_id: 'sub_1' });
    expect(new Date((await account()).current_period_end).getTime()).toBe(1_900_000_000 * 1000);
    const again = await handle(signed(e));
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
  });

  it('a failed event is forgotten, so Stripe’s retry runs it', async () => {
    stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error('Stripe is down'));
    const e = completed();
    expect((await handle(signed(e))).status).toBe(500);
    expect((await account()).plan).toBeNull();
    expect((await handle(signed(e))).status).toBe(200);
    expect((await account()).plan).toBe('solo');
  });

  it('moves between plans: completed, upgraded, past due, canceled; old events change nothing', async () => {
    await handle(signed(completed()));
    await handle(signed(event('customer.subscription.updated', subscription('sub_1', 'price_builder_test'))));
    expect((await account()).plan).toBe('builder');
    await handle(signed(event('customer.subscription.updated', subscription('sub_1', 'price_builder_test', 'past_due'))));
    expect(await account()).toMatchObject({ plan: 'builder', status: 'past_due' });
    // An older update arriving late does not undo the newer one.
    await handle(signed(event('customer.subscription.updated', subscription('sub_1', 'price_solo_test'), 1_700_000_000)));
    expect((await account()).plan).toBe('builder');
    await handle(signed(event('customer.subscription.deleted', subscription('sub_1', 'price_builder_test', 'canceled'))));
    expect(await account()).toMatchObject({ plan: null, status: 'canceled' });

    // With enforcement on, a canceled account can add nothing new.
    enforced = true;
    const p = await call('POST', '/projects', { as: 'ada@example.com', body: { name: 'More' } });
    expect(p.res.status).toBe(402);
  });

  it('ignores events it does not handle, and one-off payment sessions', async () => {
    expect((await handle(signed(event('invoice.paid', { id: 'in_1', object: 'invoice' })))).status).toBe(200);
    expect((await handle(signed(event('checkout.session.completed', { id: 'cs_2', object: 'checkout.session', mode: 'payment', customer: 'cus_ada' })))).status).toBe(200);
    expect((await account()).plan).toBeNull();
  });
});

describe('plan-state transitions', () => {
  const at = (s: number) => new Date(s * 1000);
  const change = (o: Record<string, unknown>) => ({ customerId: 'cus_1', subscriptionId: 'sub_1', plan: 'solo', status: 'active', currentPeriodEnd: at(2000), at: at(100), ...o });

  it('none → solo → builder → canceled', () => {
    let s = nextAccountState(null, change({}));
    expect(s).toMatchObject({ plan: 'solo', status: 'active', subscriptionId: 'sub_1', customerId: 'cus_1' });
    s = nextAccountState(s, change({ plan: 'builder', at: at(200) }));
    expect(s.plan).toBe('builder');
    s = nextAccountState(s, change({ plan: 'builder', status: 'canceled', deleted: true, at: at(300) }));
    expect(s).toMatchObject({ plan: null, status: 'canceled' });
  });

  it('ignores stale events and the deletion of a subscription the account replaced', () => {
    const s = nextAccountState(null, change({ subscriptionId: 'sub_2', plan: 'team', at: at(500) }));
    expect(nextAccountState(s, change({ plan: 'solo', at: at(400) }))).toBe(s);
    expect(nextAccountState(s, change({ subscriptionId: 'sub_1', deleted: true, at: at(600) }))).toBe(s);
  });

  it('reads the period end from subscription items, and the plan from the price', () => {
    expect(subscriptionState(subscription('sub_9', 'price_team_test', 'trialing', 'cus_9', 1234), PRICES)).toEqual({
      customerId: 'cus_9',
      subscriptionId: 'sub_9',
      plan: 'team',
      status: 'trialing',
      currentPeriodEnd: at(1234),
    });
    expect(subscriptionState({ ...subscription('sub_9', 'price_other'), items: { data: [{ price: { id: 'price_other' } }] }, current_period_end: 99 }, PRICES)).toMatchObject({
      plan: null,
      currentPeriodEnd: at(99),
    });
  });
});

describe('with the flags off, nothing changes', () => {
  const flows = async () => {
    await signUp('ada@example.com');
    const out: unknown[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { res, data } = await newProject('ada@example.com', `P${i}`);
      out.push(res.status);
      ids.push(data.project.id);
    }
    for (let i = 0; i < 30; i++) out.push((await call('POST', `/projects/${ids[0]}/agents`, { as: 'ada@example.com', body: { name: `a-${i}` } })).res.status);
    for (let i = 0; i < 12; i++) out.push((await call('POST', `/projects/${ids[1]}/invites`, { as: 'ada@example.com', body: { email: `p${i}@example.com` } })).res.status);
    const me = (await call('GET', '/me', { as: 'ada@example.com' })).data;
    out.push(Object.keys(me).sort());
    for (const path of ['/billing', '/billing/plans', '/billing/checkout', '/billing/portal', '/billing/webhook']) {
      const get = await call('GET', path, { as: 'ada@example.com' });
      const post = await call('POST', path, { as: 'ada@example.com', body: { plan: 'solo' } });
      const anon = await call('POST', path, { body: {} });
      out.push([path, get.res.status, get.data, post.res.status, post.data, anon.res.status]);
    }
    return out;
  };

  it('every env with billing unset or half-set answers exactly like a Cloud with no billing at all', async () => {
    makeHandler(undefined);
    const baseline = await flows();
    expect(baseline.slice(0, 54).every((s) => s === 201)).toBe(true);
    expect(baseline[54]).toEqual(['canCreate', 'projects', 'user']);

    const envs = [
      {},
      { STRIPE_SECRET_KEY: 'sk_test_x' },
      { CLOUD_BILLING_ENABLED: '1' },
      { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_SOLO: 'price_a', CLOUD_BILLING_ENFORCED: '0' },
      { CLOUD_BETA_ENDS_AT: '2099-01-01T00:00:00Z' },
    ];
    for (const env of envs) {
      db = new PGlite();
      await db.exec(schema);
      await db.exec(cloudSql);
      auth = fakeAuth();
      const make = vi.fn(() => stripe);
      makeHandler(billingFromEnv(env, make));
      expect(await flows()).toEqual(baseline);
      expect(make).not.toHaveBeenCalled();
    }
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  }, 300_000);
});
