import { IS_APP } from "../../services/platform";
import type { Book } from "../../services/types";

/**
 * Where a book can be read from here:
 *  - "server": uploaded on the website; the server has the PDF and the conversion.
 *  - "here": the PDF is on this phone.
 *  - "elsewhere": imported on another phone; this device only knows its progress and notes.
 */
export function whereIs(book: Book): "server" | "here" | "elsewhere" {
  if (book.storage_mode === "server") return "server";
  if (IS_APP && (book.device?.file || book.device?.contentKey)) return "here";
  return "elsewhere";
}

/** Book mode (reflowed text) can be opened on this device. */
export function hasBookMode(book: Book): boolean {
  if (book.chapter_count === 0) return false;
  if (book.storage_mode === "server") return true;
  return IS_APP && !!book.device?.contentKey;
}
