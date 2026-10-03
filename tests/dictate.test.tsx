// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, DEFAULT_TEXT } from '../src/react';

type Rec = { onresult: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; onend: (() => void) | null; started: boolean; stopped: boolean };
let last: Rec | null = null;
class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: Rec['onresult'] = null;
  onerror: Rec['onerror'] = null;
  onend: Rec['onend'] = null;
  started = false;
  stopped = false;
  constructor() {
    last = this as unknown as Rec;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
}
const say = (...phrases: string[]) =>
  act(() => last!.onresult!({ results: phrases.map((p) => [{ transcript: p }]) }));

beforeEach(() => {
  (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  last = null;
});
const ok = async () => ({ id: 'r1' });

describe('dictation (report 77a47290)', () => {
  it('puts what you say into the text box, after what was typed, and stops on a second click', async () => {
    render(<ReportButton areas={[]} submit={ok} />);
    await userEvent.click(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Saving fails.');
    await userEvent.click(screen.getByRole('button', { name: /Dictate/ }));
    expect(last!.started).toBe(true);
    expect(screen.getByRole('button', { name: /Listening/ })).toHaveAttribute('aria-pressed', 'true');
    say('when I press save ', 'nothing happens');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Saving fails. when I press save nothing happens');
    await userEvent.click(screen.getByRole('button', { name: /Listening/ }));
    expect(last!.stopped).toBe(true);
    expect(screen.getByRole('button', { name: /Dictate/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('has a hotkey (⌃M on a Mac) that opens the panel and listens', async () => {
    render(<ReportButton areas={[]} submit={ok} />);
    fireEvent.keyDown(window, { code: 'KeyM', key: 'm', ctrlKey: true });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(last?.started).toBe(true);
  });

  it('says so when the microphone is blocked', async () => {
    render(<ReportButton areas={[]} submit={ok} />);
    await userEvent.click(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }));
    await userEvent.click(screen.getByRole('button', { name: /Dictate/ }));
    act(() => last!.onerror!({ error: 'not-allowed' }));
    expect(screen.getByRole('alert')).toHaveTextContent('microphone is blocked');
  });

  it('is not offered where the browser cannot listen', async () => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    render(<ReportButton areas={[]} submit={ok} />);
    await userEvent.click(screen.getByRole('button', { name: DEFAULT_TEXT.openButton }));
    expect(screen.queryByRole('button', { name: /Dictate/ })).toBeNull();
  });
});
