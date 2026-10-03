// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, ShipcueBoard, DEFAULT_TEXT } from '../src/react';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('each app can use its own words', () => {
  it('in the panel: tabs, heading, placeholder, buttons and the thanks note', async () => {
    render(
      <ReportButton
        areas={[]}
        submit={async () => ({ id: 'r1' })}
        pastReportsHref="/reports"
        text={{ bugTab: 'Problem', bugTitle: 'Tell us what broke', bugPlaceholder: 'What went wrong?', send: 'Submit', sent: 'Got it.', seeReports: 'See your reports', priority: 'Urgency' }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }));
    expect(screen.getByRole('heading', { name: 'Tell us what broke' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Problem' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Feature request' })).toBeInTheDocument(); // untouched words keep the default
    expect(screen.getByText('Urgency')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('What went wrong?'), 'The heading vanished on Enter');
    await userEvent.click(screen.getByRole('button', { name: /Submit/ }));
    expect(await screen.findByText('Got it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See your reports' })).toHaveAttribute('href', '/reports');
  });

  it('on the board: tab names and empty states', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ queue: [], changelog: [] })));
    render(<ShipcueBoard refreshMs={0} liveMs={0} text={{ open: 'Waiting', changelog: 'Shipped', nothingWaiting: 'All clear.' }} />);
    expect(await screen.findByRole('tab', { name: 'Waiting 0' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Shipped' })).toBeInTheDocument();
    expect(screen.getByText('All clear.')).toBeInTheDocument();
  });
});

describe('launcherIcon (Habitect report 4d0da3e8)', () => {
  it("draws the app's mark on the button instead of the sailboat", () => {
    const { container } = render(<ReportButton areas={[]} submit={async () => ({ id: 'r1' })} launcherIcon={<svg data-icon="brand" />} />);
    const button = screen.getByRole('button', { name: DEFAULT_TEXT.openButton });
    expect(button.querySelector('[data-icon="brand"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="ship"]')).toBeNull();
  });

  it("shows shipcue's hard hat by default, and the sailboat with icon=\"ship\" (report 9806af04)", () => {
    const { unmount } = render(<ReportButton areas={[]} submit={async () => ({ id: 'r1' })} />);
    expect(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }).querySelector('[data-icon="hat"]')).not.toBeNull();
    unmount();
    render(<ReportButton areas={[]} submit={async () => ({ id: 'r1' })} icon="ship" />);
    expect(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }).querySelector('[data-icon="ship"]')).not.toBeNull();
  });
});
