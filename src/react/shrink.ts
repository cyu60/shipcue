// Screenshots pasted from a retina Mac are 3–6 MB. Shrinking them in the
// browser keeps reports under the request limits and makes them upload fast.

export const SHRINK_ABOVE_BYTES = 800 * 1024;
const MAX_DIMENSION = 1800;
const QUALITY = 0.85;
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function needsShrink(file: File): boolean {
  return RASTER.has(file.type) && file.size > SHRINK_ABOVE_BYTES;
}

/** Re-encodes a large raster image as JPEG at most 1800px on the long side. Returns the original on any failure. */
export async function shrinkImage(file: File): Promise<File> {
  if (!needsShrink(file)) return file;
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
