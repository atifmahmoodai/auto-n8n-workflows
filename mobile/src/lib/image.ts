import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/** Long edge in px. Claude downsizes larger images anyway; this keeps uploads ~300-700 KB. */
const MAX_EDGE = 2000;

export type PreparedImage = { uri: string; base64: string };

export async function prepareReceiptImage(uri: string, width: number, height: number): Promise<PreparedImage> {
  const context = ImageManipulator.manipulate(uri);
  const longEdge = Math.max(width, height);
  if (longEdge > MAX_EDGE) {
    context.resize(width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  }
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ base64: true, compress: 0.8, format: SaveFormat.JPEG });
  context.release();
  rendered.release();
  if (!result.base64) throw new Error("Could not encode image");
  return { uri: result.uri, base64: result.base64 };
}

function receiptsDir(): Directory {
  const dir = new Directory(Paths.document, "receipts");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Copies the (cache) image into permanent app storage and returns the new URI. */
export function persistReceiptImage(cacheUri: string, receiptId: string): string {
  const target = new File(receiptsDir(), `${receiptId}.jpg`);
  if (target.exists) target.delete();
  new File(cacheUri).copySync(target);
  return target.uri;
}

export function deleteReceiptImage(uri: string | null) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("Failed to delete receipt image", error);
  }
}

export function deleteAllReceiptImages() {
  try {
    const dir = new Directory(Paths.document, "receipts");
    if (dir.exists) dir.delete();
  } catch (error) {
    console.warn("Failed to delete receipt images", error);
  }
}
