// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ReportButton } from '../src/react';

// "Copy prompt for my agent" (shipcue report 9f533ece): the agent fills the form out and files it.
let copied = '';
beforeEach(() => {
  copied = '';
  localStorage.clear();
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (s: string) => void (copied = s)) },
  });
  window.history.replaceState(null, '', '/settings/billing?tab=2');
  document.title = 'Acme';
});
afterEach(cleanup);

const fab = () => screen.getAllByRole('button').find((b) => b.querySelector('[data-icon="hat"]'))!;

describe('copy a prompt for my agent (report 9f533ece)', () => {
  it('copies everything the agent needs to fill the form out and file it', async () => {
    render(
      <ReportButton
        endpoint="/api/shipcue"
        areas={[{ value: 'billing', label: 'Billing' }]}
        diagnostics={() => ({ plan: 'pro', seats: 3 })}
        getContext={() => 'Invoice #42 row'}
        captureErrors={false}
      />,
    );
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: 'Feature request' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Export invoices as CSV' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for my agent' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());

    const origin = window.location.origin;
    // The app and the page.
    expect(copied).toContain('Acme');
    expect(copied).toContain(`${origin}/settings/billing?tab=2`);
    // What the form offers, and what is chosen.
    expect(copied).toContain('Type: feature');
    expect(copied).toMatch(/bug.*feature.*task/);
    expect(copied).toContain('Priority: medium');
    expect(copied).toMatch(/low.*medium.*high.*blocking/s);
    expect(copied).toContain('billing (Billing)');
    expect(copied).toContain('other (Other)');
    // What was typed, the picked-out context and the snapshot shipcue would attach.
    expect(copied).toContain('Export invoices as CSV');
    expect(copied).toContain('Invoice #42 row');
    expect(copied).toContain('{"plan":"pro","seats":3}');
    // How to file it: the MCP tool first, then curl to the absolute endpoint.
    expect(copied).toContain('file_report');
    expect(copied).toContain(`curl -X POST '${origin}/api/shipcue/reports'`);
    expect(copied).toContain("-F 'type=feature'");
    expect(copied).toContain("--form-string description='Export invoices as CSV'");
    expect(copied).toContain(`-F 'pageUrl=${origin}/settings/billing?tab=2'`);
    expect(copied).toContain(`--form-string diagnostics='{"plan":"pro","seats":3}'`);
    expect(copied).toMatch(/ask (me|the person)/i);
  });

  it('says nothing is written yet, and is hidden on an app-defined tab', async () => {
    render(<ReportButton endpoint="https://queue.example.com/api/shipcue/" extraTabs={[{ id: 'x', label: 'Mine', render: () => null }]} />);
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for my agent' }));
    await waitFor(() => expect(copied).not.toBe(''));
    expect(copied).toContain("curl -X POST 'https://queue.example.com/api/shipcue/reports'");
    expect(copied).toMatch(/nothing (written )?yet/i);
    fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    expect(screen.queryByRole('button', { name: 'Copy prompt for my agent' })).toBeNull();
  });

  it('uses the app’s own words for the control', async () => {
    render(<ReportButton endpoint="/api/shipcue" text={{ copyAgentPrompt: 'Let my agent do it' }} />);
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Let my agent do it' })).toBeInTheDocument();
  });
});

describe('agentPromptAuth: endpoints that need a token', () => {
  it('puts the header on the curl, the token on the MCP line, and says where to get one', async () => {
    render(<ReportButton endpoint="/api/v1/reports-shipcue" areas={[]} captureErrors={false} agentPromptAuth={{ header: 'Authorization: Bearer <token>', where: 'https://app.example.com/settings/tokens' }} />);
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for my agent' }));
    await waitFor(() => expect(copied).not.toBe(''));
    expect(copied).toContain('## Auth');
    expect(copied).toContain('Authorization: Bearer <token>');
    expect(copied).toContain('https://app.example.com/settings/tokens');
    expect(copied).toContain("-H 'Authorization: Bearer <token>'");
    expect(copied).toContain('-e SHIPCUE_TOKEN=<token>');
  });

  it('says nothing about auth when the endpoint needs none', async () => {
    render(<ReportButton endpoint="/api/shipcue" areas={[]} captureErrors={false} />);
    fireEvent.click(fab());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for my agent' }));
    await waitFor(() => expect(copied).not.toBe(''));
    expect(copied).not.toContain('## Auth');
    expect(copied).not.toContain('SHIPCUE_TOKEN');
  });
});

