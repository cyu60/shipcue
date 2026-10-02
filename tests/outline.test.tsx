// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton } from '../src/react';
import { isOutlineText, OutlinePreview, parseOutline } from '../src/react/outline';

afterEach(cleanup);
const ok = () => async () => ({ id: 'r1' });

describe('the Context preview (report 0fcc360a)', () => {
  it('reads a bulleted outline as a tree, keeping wrapped lines with their block', () => {
    expect(isOutlineText('just a sentence')).toBe(false);
    expect(parseOutline('- a\n  - b\n    more of b\n  - c\n- d')).toEqual([
      { text: 'a', children: [{ text: 'b\nmore of b', children: [] }, { text: 'c', children: [] }] },
      { text: 'd', children: [] },
    ]);
  });

  it('draws bullets with [[links]], #tags, ((refs)), **bold** and `code` set apart', () => {
    render(<OutlinePreview text={'- Met [[Jeffery Zhou]] about #outliner\n  - see ((abc123)) and **this** `now`'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Jeffery Zhou').closest('span')?.textContent).toBe('[[Jeffery Zhou]]');
    expect(screen.getByText('#outliner')).toBeInTheDocument();
    expect(screen.getByText('this').tagName).toBe('STRONG');
    expect(screen.getByText('now').tagName).toBe('CODE');
  });

  it("uses the app's own renderer when given", async () => {
    render(<ReportButton areas={[]} submit={ok()} getContext={() => '- a block'} renderContext={(t) => <p>app renders: {t}</p>} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(within(screen.getByLabelText('Context preview')).getByText('app renders: - a block')).toBeInTheDocument();
  });

  it('opens plain text as Raw, ready to edit', async () => {
    render(<ReportButton areas={[]} submit={ok()} getContext={() => 'one plain sentence'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    expect(screen.getByRole('textbox', { name: 'Context' })).toHaveValue('one plain sentence');
  });
});

describe('adding context by hand (Habitect report 17748c25)', () => {
  it('opens an empty box to type into when nothing is selected', async () => {
    render(<ReportButton areas={[]} submit={ok()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add context' }));
    const box = screen.getByRole('textbox', { name: 'Context' });
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(screen.queryByRole('button', { name: '+ Add context' })).toBeNull();
  });

  it("takes what the app says is selected, as a preview", async () => {
    let selected: string | null = null;
    render(<ReportButton areas={[]} submit={ok()} getContext={() => selected} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report a bug or request a feature' }));
    selected = '- picked block\n  - its child';
    await userEvent.click(screen.getByRole('button', { name: '+ Add context' }));
    expect(within(screen.getByLabelText('Context preview')).getByText('its child')).toBeInTheDocument();
  });
});
