import sharp from 'sharp';
import { badRequest } from './errors.js';

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif', 'tiff']);

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

/**
 * Decodes an uploaded image (rejecting anything that is not really an image), applies the EXIF
 * orientation, strips all metadata (phone photos carry GPS coordinates of the customer's home) and
 * produces a web-sized JPEG plus a thumbnail.
 */
export async function processPhoto(input: Buffer): Promise<ProcessedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { failOn: 'error', limitInputPixels: 80_000_000 }).metadata();
  } catch {
    throw badRequest('That file is not a supported image (use JPEG, PNG or WebP)');
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw badRequest('That file is not a supported image (use JPEG, PNG or WebP)');
  }
  try {
    const base = sharp(input, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate();
    const { data: full, info } = await base
      .clone()
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base
      .clone()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    return { full, thumb, width: info.width, height: info.height };
  } catch {
    throw badRequest('The image could not be processed (it may be corrupted)');
  }
}
