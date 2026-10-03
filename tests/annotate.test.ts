import { describe, it, expect } from 'vitest';
import { clear, emptyHistory, live, push, redo, undo, viewOf, between, strokeFor, type Mark } from '../src/react/annotate';
import { cropRect, rectFrom } from '../src/react/capture';

// shipcue report 58b727d9: the selection maths and the annotator's undo stack.
describe('selecting an area', () => {
  it('makes a rectangle from a drag in any direction, kept inside the viewport', () => {
    const vp = { width: 800, height: 600 };
    expect(rectFrom({ x: 300, y: 200 }, { x: 100, y: 50 }, vp)).toEqual({ x: 100, y: 50, width: 200, height: 150 });
    expect(rectFrom({ x: 700, y: 500 }, { x: 900, y: 700 }, vp)).toEqual({ x: 700, y: 500, width: 100, height: 100 });
    expect(rectFrom({ x: -20, y: 10 }, { x: 40, y: 30 }, vp)).toEqual({ x: 0, y: 10, width: 40, height: 20 });
  });

  it('crops at devicePixelRatio when the tab is captured at its own size', () => {
    const sel = { x: 10.5, y: 20, width: 100, height: 50 };
    expect(cropRect(sel, { width: 1600, height: 1200 }, { width: 800, height: 600 }, 2)).toEqual({ x: 21, y: 40, width: 200, height: 100 });
    expect(cropRect(sel, { width: 800, height: 600 }, { width: 800, height: 600 }, 1)).toEqual({ x: 10, y: 20, width: 101, height: 50 });
  });

  it('measures the scale from the frame when the browser scales the capture, and stays inside it', () => {
    // A 2x screen captured at 1.5x.
    expect(cropRect({ x: 100, y: 100, width: 200, height: 100 }, { width: 1200, height: 900 }, { width: 800, height: 600 }, 2)).toEqual({ x: 150, y: 150, width: 300, height: 150 });
    // A "sharing this tab" bar trimmed the frame: the crop stops at its edge.
    expect(cropRect({ x: 0, y: 500, width: 100, height: 100 }, { width: 1600, height: 1100 }, { width: 800, height: 600 }, 2)).toEqual({ x: 0, y: 1000, width: 200, height: 100 });
  });
});

describe('the annotator history', () => {
  const pen: Mark = { kind: 'pen', color: '#e11d48', width: 4, points: [{ x: 1, y: 1 }] };
  const box: Mark = { kind: 'rect', color: '#2563eb', width: 4, rect: { x: 0, y: 0, width: 5, height: 5 } };

  it('undoes and redoes in order, and a new mark drops what was undone', () => {
    let h = push(push(emptyHistory(), pen), box);
    h = undo(h);
    expect(h.done).toEqual([pen]);
    expect(h.undone).toEqual([box]);
    h = redo(h);
    expect(h.done).toEqual([pen, box]);
    h = undo(undo(h));
    expect(h.done).toEqual([]);
    expect(undo(h)).toBe(h);
    h = push(h, box);
    expect(h.undone).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it('clears in a way that can be undone', () => {
    let h = clear(push(emptyHistory(), pen));
    expect(live(h.done)).toEqual([]);
    h = undo(h);
    expect(live(h.done)).toEqual([pen]);
    expect(clear(emptyHistory()).done).toEqual([]);
  });

  it('shows the last crop, and all of the image without one', () => {
    const img = { width: 400, height: 300 };
    expect(viewOf([], img)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    const crop: Mark = { kind: 'crop', rect: between({ x: 50, y: 60 }, { x: 10, y: 20 }) };
    expect(viewOf([pen, crop], img)).toEqual({ x: 10, y: 20, width: 40, height: 40 });
    expect(viewOf([crop, { kind: 'clear' }], img)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('thickens lines on big images so S, M and L read the same', () => {
    expect(strokeFor('M', 1000)).toBe(6);
    expect(strokeFor('M', 2000)).toBe(12);
    expect(strokeFor('S', 100)).toBeGreaterThanOrEqual(1);
  });
});
