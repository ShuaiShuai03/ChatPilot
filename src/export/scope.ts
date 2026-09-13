import type { ExportMode, MessageRecord } from '../conversation/types';

/** Returns canonical records in their original conversation order. */
export function selectMessages(
  records: readonly MessageRecord[],
  mode: ExportMode,
  selectedIds: ReadonlySet<string>,
): MessageRecord[] {
  switch (mode) {
    case 'all':
      return records.slice();
    case 'assistant':
      return records.filter((record) => record.role === 'assistant');
    case 'selected':
      return records.filter((record) => selectedIds.has(record.id));
  }
}
