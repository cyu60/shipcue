// InsForge as the admin's sign-in and email (what shipcue Cloud runs on). Any other provider plugs in
// through the same AdminAuth shape.
import type { EmailMessage } from '../server';
import type { AdminAuth, AuthTokens } from './handler';
import type { FetchLike } from './hosted';

interface InsforgeReply {
  accessToken?: string;
  refreshToken?: string;
  user?: { id: string; email: string };
  authUrl?: unknown;
  message?: string;
  error?: string;
}

/** InsForge auth over REST, as a server client (tokens come back in the body, not cookies). */
export function insforgeAuth(baseUrl: string | undefined, fetchImpl: FetchLike = fetch): Required<AdminAuth> {
  const call = async (path: string, payload?: unknown, token?: string): Promise<InsforgeReply> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: payload ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as InsforgeReply;
    if (!res.ok) throw Object.assign(new Error(data.message ?? data.error ?? `Sign-in service said ${res.status}`), { status: res.status });
    return data;
  };
  const tokens = (d: InsforgeReply): AuthTokens | null => (d.accessToken ? { accessToken: d.accessToken, refreshToken: d.refreshToken, user: d.user } : null);
  return {
    async signUp(email, password) {
      const d = await call('/api/auth/users?client_type=server', { email, password });
      return { tokens: tokens(d), needsVerification: !d.accessToken };
    },
    async verify(email, otp) {
      return tokens(await call('/api/auth/email/verify?client_type=server', { email, otp }));
    },
    async resend(email) {
      await call('/api/auth/email/send-verification', { email });
    },
    async signIn(email, password) {
      return tokens(await call('/api/auth/sessions?client_type=server', { email, password }));
    },
    async current(accessToken) {
      const d = await call('/api/auth/sessions/current', null, accessToken);
      return d.user ? { id: d.user.id, email: d.user.email } : null;
    },
    async refresh(refreshToken) {
      return tokens(await call('/api/auth/refresh?client_type=server', { refreshToken }));
    },
    /** The provider's sign-in page (Google, GitHub) for a PKCE challenge; it comes back to redirectUri with ?insforge_code. */
    async oauthUrl(provider, redirectUri, codeChallenge) {
      const qs = new URLSearchParams({ redirect_uri: redirectUri, code_challenge: codeChallenge });
      const d = await call(`/api/auth/oauth/${encodeURIComponent(provider)}?${qs}`);
      if (typeof d.authUrl !== 'string' || !d.authUrl.startsWith('https://')) throw new Error('The sign-in service gave no sign-in page.');
      return d.authUrl;
    },
    async exchange(code, codeVerifier) {
      return tokens(await call('/api/auth/oauth/exchange?client_type=server', { code, code_verifier: codeVerifier }));
    },
    // Forgot password, by code (the project's resetPasswordMethod must be "code", like its email verification).
    async sendReset(email) {
      await call('/api/auth/email/send-reset-password', { email });
    },
    async resetPassword(email, code, password) {
      const d = (await call('/api/auth/email/exchange-reset-password-token', { email, code })) as InsforgeReply & { token?: string };
      if (!d.token) throw new Error('That code did not work. Ask for a new one.');
      await call('/api/auth/email/reset-password', { newPassword: password, otp: d.token });
      return tokens(await call('/api/auth/sessions?client_type=server', { email, password }));
    },
  };
}

/** Sends one email with InsForge's emails; null without a key. */
export function insforgeEmail(baseUrl: string | undefined, apiKey: string | undefined, fetchImpl: FetchLike = fetch): ((m: EmailMessage) => Promise<void>) | null {
  if (!apiKey) return null;
  return async (m) => {
    const res = await fetchImpl(`${baseUrl}/api/email/send-raw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: m.to, subject: m.subject, html: m.html, from: 'shipcue' }),
    });
    if (!res.ok) throw new Error(`email: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
}
