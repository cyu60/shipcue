// The panel's Context preview (shipcue report 0fcc360a, from Habitect): picked-out blocks
// drawn as an outline, with [[links]], #tags, ((refs)), **bold** and `code` set apart,
// instead of the raw text. Apps with their own renderer pass renderContext instead.
import { Fragment, type CSSProperties, type ReactNode } from 'react';

export interface OutlineNode {
  text: string;
  children: OutlineNode[];
}

const BULLET = /^(\s*)[-*]\s+(.*)$/;

/** True when the text is a bulleted outline ("- a\n  - b"), not a plain paragraph. */
export function isOutlineText(text: string): boolean {
  return text.split('\n').some((l) => BULLET.test(l));
}

/** "- a\n  - b\n- c" as a tree; a line without a bullet continues the block above it. */
export function parseOutline(text: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { indent: number; node: OutlineNode }[] = [];
  for (const raw of text.replace(/\t/g, '  ').split('\n')) {
    if (!raw.trim()) continue;
    const m = BULLET.exec(raw);
    if (!m) {
      const last = stack[stack.length - 1];
      if (last) last.node.text += `\n${raw.trim()}`;
      else roots.push({ text: raw.trim(), children: [] });
      continue;
    }
    const indent = m[1]!.length;
    const node: OutlineNode = { text: m[2]!, children: [] };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.node.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

const INLINE = /(\[\[[^\]]+\]\]|\(\([^)]+\)\)|\*\*[^*]+\*\*|`[^`]+`|(?:^|(?<=\s))#[\w/-]+)/g;

/** One line's marks: [[page]], ((ref)), **bold**, `code`, #tag. Everything else stays text. */
export function Inline({ text, accent = '#2563eb' }: { text: string; accent?: string }) {
  const parts = text.split(INLINE).filter((p) => p !== '');
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('[[') && p.endsWith(']]')) {
          return (
            <span key={i} style={{ color: accent }}>
              <span style={s.bracket}>[[</span>
              {p.slice(2, -2)}
              <span style={s.bracket}>]]</span>
            </span>
          );
        }
        if (p.startsWith('((') && p.endsWith('))')) return <span key={i} style={s.ref}>{p.slice(2, -2)}</span>;
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i} style={s.code}>{p.slice(1, -1)}</code>;
        if (p.startsWith('#')) return <span key={i} style={{ color: accent }}>{p}</span>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

function Nodes({ nodes, accent }: { nodes: OutlineNode[]; accent: string }) {
  return (
    <ul style={s.ul}>
      {nodes.map((n, i) => (
        <li key={i} style={s.li}>
          <span style={{ whiteSpace: 'pre-wrap' }}>
            <Inline text={n.text} accent={accent} />
          </span>
          {n.children.length > 0 && <Nodes nodes={n.children} accent={accent} />}
        </li>
      ))}
    </ul>
  );
}

/** The Context as an outline (or one paragraph), read-only. */
export function OutlinePreview({ text, accent = '#2563eb' }: { text: string; accent?: string }): ReactNode {
  if (!isOutlineText(text)) {
    return (
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        <Inline text={text} accent={accent} />
      </p>
    );
  }
  return <Nodes nodes={parseOutline(text)} accent={accent} />;
}

const s: Record<string, CSSProperties> = {
  ul: { margin: 0, paddingLeft: 16, listStyle: 'disc' },
  li: { margin: '1px 0' },
  bracket: { opacity: 0.45 },
  ref: { padding: '0 3px', borderBottom: '1px solid #d4d4d8', color: '#3f3f46' },
  code: { padding: '0 3px', borderRadius: 3, background: '#f4f4f5', fontSize: '0.92em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
};
