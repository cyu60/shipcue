// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportButton, type DescriptionEditorProps } from '../src/react';

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

/** An app's editor: a single-line input, with a switch back to shipcue's own text box. */
function Editor(props: DescriptionEditorProps) {
  const [raw, setRaw] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setRaw((r) => !r)}>
        Raw text
      </button>
      {raw ? (
        props.textarea
      ) : (
        <input
          aria-label="My editor"
          data-type={props.type}
          placeholder={props.placeholder}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.submit();
          }}
        />
      )}
    </>
  );
}

describe('ReportButton: renderDescription', () => {
  it('draws shipcue’s text box when it is not given', async () => {
    await open({});
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA');
    expect(document.querySelector('[data-shipcue-description]')).toBeNull();
  });

  it('draws the app’s editor in place of the text box, and sends what it writes', async () => {
    const submit = await open({ renderDescription: (p) => <Editor {...p} /> });
    expect(screen.queryByLabelText('Description')).toBeNull();
    const editor = screen.getByLabelText('My editor');
    expect(editor.closest('[data-shipcue-description]')).not.toBeNull();
    expect(editor.dataset.type).toBe('bug');
    await userEvent.type(editor, '- the evening block jumps');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const form = submit.mock.calls[0]![0] as FormData;
    expect(form.get('description')).toBe('- the evening block jumps');
  });

  it('gives submit, which sends once the text is long enough', async () => {
    const submit = await open({ renderDescription: (p) => <Editor {...p} /> });
    const editor = screen.getByLabelText('My editor');
    await userEvent.type(editor, 'no{Enter}');
    expect(submit).not.toHaveBeenCalled();
    await userEvent.type(editor, ' wait, the page jumps on Enter{Enter}');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('hands over shipcue’s own text box, sharing the same text both ways', async () => {
    const submit = await open({ renderDescription: (p) => <Editor {...p} /> });
    await userEvent.type(screen.getByLabelText('My editor'), 'typed in the editor');
    await userEvent.click(screen.getByRole('button', { name: 'Raw text' }));
    const box = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(box.value).toBe('typed in the editor');
    expect(box.closest('[data-shipcue-description]')).not.toBeNull();
    fireEvent.change(box, { target: { value: 'typed in the editor, then raw' } });
    await userEvent.click(screen.getByRole('button', { name: 'Raw text' }));
    expect((screen.getByLabelText('My editor') as HTMLInputElement).value).toBe('typed in the editor, then raw');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((submit.mock.calls[0]![0] as FormData).get('description')).toBe('typed in the editor, then raw');
  });

  it('gives the tab and its placeholder', async () => {
    const seen: DescriptionEditorProps[] = [];
    await open({
      types: ['feature'],
      renderDescription: (p) => {
        seen.push(p);
        return <Editor {...p} />;
      },
    });
    expect(seen.at(-1)?.type).toBe('feature');
    expect(seen.at(-1)?.placeholder).toBeTruthy();
  });

  it('gives addFiles, which attaches files as pasting them does', async () => {
    let add: DescriptionEditorProps['addFiles'] = () => undefined;
    const submit = await open({
      renderDescription: (p) => {
        add = p.addFiles;
        return <Editor {...p} />;
      },
    });
    const shot = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    add([shot]);
    await userEvent.type(screen.getByLabelText('My editor'), 'with a screenshot attached');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const form = submit.mock.calls[0]![0] as FormData;
    expect(form.getAll('screenshot')).toHaveLength(1);
  });
});
