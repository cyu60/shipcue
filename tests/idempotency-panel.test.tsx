// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, openReport } from '../src/react';
import { cleanIdempotencyKey } from '../src/core';

// Retry-safe filing (shipcue report 9833fd28): one key per draft, kept across retries.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

type Result = { id: string } | { error: string };
const areas = [{ value: 'editor', label: 'Editor' }];
const keysOf = (submit: ReturnType<typeof vi.fn>) => submit.mock.calls.map((c) => (c[0] as FormData).get('idempotencyKey'));
const openButton = () => screen.getByRole('button', { name: 'Report a bug or request a feature' });

async function write(text: string) {
  await userEvent.type(screen.getByRole('textbox'), text);
}
const send = () => userEvent.click(screen.getByRole('button', { name: 'Send' }));

describe('ReportButton idempotencyKey', () => {
  it('gives a custom submit the key, in a safe form the handler accepts', async () => {
    const submit = vi.fn(async (_f: FormData): Promise<Result> => ({ id: 'r1' }));
    render(<ReportButton areas={areas} submit={submit} />);
    await userEvent.click(openButton());
    await write('Heading disappears on Enter');
    await send();
    const key = keysOf(submit)[0];
    expect(typeof key).toBe('string');
    expect(cleanIdempotencyKey(key)).toBe(key);
  });

  it('reuses the key when a failed send is retried (even after an edit), and renews it after a success', async () => {
    const results: (Result | Error)[] = [{ error: 'Could not save the report.' }, new Error('Failed to fetch'), { id: 'r1' }, { id: 'r2' }];
    const submit = vi.fn(async (_f: FormData): Promise<Result> => {
      const r = results.shift()!;
      if (r instanceof Error) throw r;
      return r;
    });
    render(<ReportButton areas={areas} submit={submit} />);
    await userEvent.click(openButton());
    await write('Heading disappears on Enter');
    await send(); // the server said no (a timeout, a stalled database)
    expect(await screen.findByText('Could not save the report.')).toBeInTheDocument();
    await write(' again');
    await send(); // the network failed
    await send(); // this one lands
    const [k1, k2, k3] = keysOf(submit);
    expect(k1).toBeTruthy();
    expect(k2).toBe(k1);
    expect(k3).toBe(k1);
    // A new report after a success gets a new key.
    await userEvent.click(openButton());
    await write('Another thing entirely');
    await send();
    expect(keysOf(submit)[3]).not.toBe(k1);
  });

  it('a fresh open (hotkey or openReport) starts a new report with a new key', async () => {
    const submit = vi.fn(async (_f: FormData): Promise<Result> => ({ error: 'Could not save the report.' }));
    render(<ReportButton areas={areas} submit={submit} />);
    await userEvent.click(openButton());
    await write('Heading disappears on Enter');
    await send();
    await send();
    act(() => openReport('bug'));
    await write('A different report altogether');
    await send();
    const [k1, k2, k3] = keysOf(submit);
    expect(k2).toBe(k1);
    expect(k3).not.toBe(k1);
  });

  it('closing and reopening keeps the key while the draft is kept, and renews it once the draft was cleared', async () => {
    const submit = vi.fn(async (_f: FormData): Promise<Result> => ({ error: 'Could not save the report.' }));
    render(<ReportButton areas={areas} submit={submit} />);
    await userEvent.click(openButton());
    await write('Heading disappears on Enter');
    await send();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(openButton());
    await send();
    const [k1, k2] = keysOf(submit);
    expect(k2).toBe(k1);
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(openButton());
    await write('Something new to say here');
    await send();
    expect(keysOf(submit)[2]).not.toBe(k1);
  });

  it('sends the key to the handler as a form field', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/capabilities')) return new Response('{}', { status: 404 });
      void init;
      return new Response(JSON.stringify({ id: 'r1' }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<ReportButton areas={areas} endpoint="/api/shipcue" />);
      await userEvent.click(openButton());
      await write('Heading disappears on Enter');
      await send();
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/reports'))!;
      expect(typeof (call[1]!.body as FormData).get('idempotencyKey')).toBe('string');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
