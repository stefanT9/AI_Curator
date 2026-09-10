/**
 * Shrink a selected image before it is sent for analysis.
 *
 * A 10 MB photograph carries no more tagging signal than a 768px JPEG, but it
 * costs far more image tokens and far more time on the wire. Downscaling first
 * is what keeps a suggestion inside the latency budget — and keeps the request
 * well under the Server Action body cap.
 *
 * Browser-only: uses `createImageBitmap` and a canvas. Never import this from a
 * server module, and never add "server-only" to it.
 */

/** Longest edge of the downscaled image, in pixels. Ample for tagging. */
const MAX_EDGE = 768;

/** Visually lossless enough for this purpose, at a fraction of the bytes. */
const JPEG_QUALITY = 0.8;

export const downscaleToDataUrl = async (
  file: File,
  maxEdge = MAX_EDGE,
): Promise<string> => {
  const bitmap = await createImageBitmap(file);

  try {
    // Never upscale: an image already inside the budget is re-encoded at its
    // own size, not stretched to fill it.
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not read the image.");
    }

    context.drawImage(bitmap, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    // The bitmap holds decoded pixels — a full-resolution photo's worth.
    bitmap.close();
  }
};
