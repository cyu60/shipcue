'use client';

// Screen recordings for reports: record the screen, a window or a tab, with
// time and size caps, in whatever format this browser records.

import { videoType } from '../core';

/** About 7.5 MB a minute: sharp enough to read text in a screen recording. */
const BITS_PER_SECOND = 1_000_000;

export function canRecordScreen(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

function pickMimeType(): string {
  for (const type of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export interface ScreenRecording {
  stop(): void;
}
export interface RecordingResult {
  blob: Blob | null;
  /** Why it stopped early, if it did. */
  note: string | null;
}

/**
 * Ask which screen, window or tab to share and record it until stop(), the
 * browser's own Stop sharing, the time cap or the size cap; then call onDone
 * once. Rejects if sharing was refused.
 */
export async function recordScreen(opts: {
  maxSeconds: number;
  maxBytes: number;
  onTick: (seconds: number) => void;
  onDone: (result: RecordingResult) => void;
}): Promise<ScreenRecording> {
  const options: DisplayMediaStreamOptions & { selfBrowserSurface?: 'include' | 'exclude' } = {
    video: { frameRate: 15 },
    audio: false,
    selfBrowserSurface: 'include',
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const mimeType = pickMimeType();
  let media: MediaRecorder;
  try {
    media = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: BITS_PER_SECOND });
  } catch (e) {
    for (const track of stream.getTracks()) track.stop();
    throw e;
  }
  const chunks: Blob[] = [];
  let bytes = 0;
  let note: string | null = null;
  const started = Date.now();
  const stop = () => {
    if (media.state !== 'inactive') media.stop();
  };
  const tick = setInterval(() => opts.onTick(Math.floor((Date.now() - started) / 1000)), 1000);
  const cap = setTimeout(() => {
    note = `Recording stopped at ${opts.maxSeconds} seconds.`;
    stop();
  }, opts.maxSeconds * 1000);
  media.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    if (bytes + e.data.size > opts.maxBytes) {
      note = 'Recording stopped: the video reached the size limit.';
      stop();
      return;
    }
    bytes += e.data.size;
    chunks.push(e.data);
  };
  media.onstop = () => {
    clearInterval(tick);
    clearTimeout(cap);
    for (const track of stream.getTracks()) track.stop();
    const type = videoType(media.mimeType || mimeType) ?? 'video/webm';
    opts.onDone({ blob: chunks.length > 0 ? new Blob(chunks, { type }) : null, note });
  };
  stream.getVideoTracks()[0]?.addEventListener('ended', stop);
  try {
    media.start(1000);
  } catch (e) {
    clearInterval(tick);
    clearTimeout(cap);
    for (const track of stream.getTracks()) track.stop();
    throw e;
  }
  return { stop };
}

/** A message for a failed start; null when the person just cancelled the picker. */
export function shareError(error: unknown): string | null {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  return 'Could not start the screen recording.';
}
