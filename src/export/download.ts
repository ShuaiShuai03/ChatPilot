import type { ExportFormat } from '../conversation/types';
import { zh } from '../ui/zh';

const FALLBACK_TITLE = zh.defaultConversationTitle;
const MAX_TITLE_LENGTH = 80;

function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u0080-\u009f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const bounded = Array.from(cleaned).slice(0, MAX_TITLE_LENGTH).join('').replace(/[. ]+$/g, '');
  return bounded || FALLBACK_TITLE;
}

/** Creates a portable filename with a UTC timestamp and the requested format. */
export function exportFilename(
  title: string,
  exportedAt: string,
  format: ExportFormat,
): string {
  const timestamp = new Date(exportedAt).toISOString().replace(/:/g, '-');
  return `${sanitizeTitle(title)}-${timestamp}.${format}`;
}

/** Downloads in-memory export content without requesting extension permissions. */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;

  try {
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body ?? document.documentElement).append(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
