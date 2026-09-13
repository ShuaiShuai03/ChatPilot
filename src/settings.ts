import { storage } from 'wxt/utils/storage';
import type { ExportFormat } from './conversation/types';

export interface Settings {
  navigatorEnabled: boolean;
  smoothScroll: boolean;
  defaultExportFormat: ExportFormat;
  defaultExportMode: 'all' | 'assistant';
  navigatorWidth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  navigatorEnabled: true,
  smoothScroll: true,
  defaultExportFormat: 'md',
  defaultExportMode: 'all',
  navigatorWidth: 320,
};

export function normalizeSettings(value: unknown): Settings {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    navigatorEnabled: typeof candidate.navigatorEnabled === 'boolean' ? candidate.navigatorEnabled : true,
    smoothScroll: typeof candidate.smoothScroll === 'boolean' ? candidate.smoothScroll : true,
    defaultExportFormat: candidate.defaultExportFormat === 'json' || candidate.defaultExportFormat === 'txt' ? candidate.defaultExportFormat : 'md',
    defaultExportMode: candidate.defaultExportMode === 'assistant' ? 'assistant' : 'all',
    navigatorWidth: typeof candidate.navigatorWidth === 'number' && Number.isFinite(candidate.navigatorWidth)
      ? Math.min(420, Math.max(260, Math.round(candidate.navigatorWidth))) : 320,
  };
}

export const settingsItem = storage.defineItem<Settings>('local:chatpilot:settings', { fallback: DEFAULT_SETTINGS });
