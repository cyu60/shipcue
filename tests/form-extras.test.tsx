// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton } from '../src/react';

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

const ok = () => vi.fn(async (_f: FormData) => ({ id: 'r1' }) as { id: string } | { error: string });

async function open(props: Partial<Parameters<typeof ReportButton>[0]>) {
  const submit = ok();
  render(<ReportButton submit={submit} {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
  return submit;
}

describe('ReportButton: an app’s own fields', () => {
  it('draws formExtras in the bug and feature form', async () => {
    await open({ formExtras: <label><input type="checkbox" /> Pin it</label> });
    expect(screen.getByLabelText('Pin it')).toBeInTheDocument();
  });

  it('sends fields with the report, read at the moment it is sent', async () => {
    let pinned = false;
    const submit = await open({ fields: () => ({ pinned: pinned ? '1' : '0', source: 'panel' }) });
    pinned = true;
    await userEvent.type(screen.getByRole('textbox'), 'Pin this one before it goes');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const form = submit.mock.calls[0]![0] as FormData;
    expect(form.get('pinned')).toBe('1');
    expect(form.get('source')).toBe('panel');
  });

  it('never lets fields replace shipcue’s own fields', async () => {
    const submit = await open({ fields: () => ({ description: 'hijacked', extra: 'kept' }) });
    await userEvent.type(screen.getByRole('textbox'), 'The real description here');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const form = submit.mock.calls[0]![0] as FormData;
    expect(form.get('description')).toBe('The real description here');
    expect(form.get('extra')).toBe('kept');
  });
});
