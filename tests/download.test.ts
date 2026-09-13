import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

import { downloadFile, exportFilename } from '../src/export/download';

describe('exportFilename', () => {
  it('keeps Unicode while making a bounded portable UTC filename', () => {
    expect(
      exportFilename('  项目/报告:*? <一>...  ', '2026-09-12T08:09:10.123-07:00', 'md'),
    ).toBe('项目-报告--- -一--2026-09-12T15-09-10.123Z.md');
  });

  it('uses the fallback for an empty or invalid Windows basename', () => {
    expect(exportFilename(' . ', '2026-09-12T08:09:10.123Z', 'json')).toBe(
      'ChatGPT 对话-2026-09-12T08-09-10.123Z.json',
    );
  });
});

describe('downloadFile', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    createObjectURL.mockReturnValue('blob:chatpilot-export');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a temporary download link and revokes the object URL after cleanup', () => {
    downloadFile('内容', '对话.md', 'text/markdown;charset=utf-8');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(document.querySelector('a')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:chatpilot-export');
  });

  it('schedules URL cleanup when link setup fails', () => {
    vi.spyOn(document.body, 'append').mockImplementation(() => {
      throw new Error('append failed');
    });

    expect(() => downloadFile('text', 'conversation.txt', 'text/plain')).toThrow('append failed');
    expect(document.querySelector('a')).toBeNull();

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:chatpilot-export');
  });
});
