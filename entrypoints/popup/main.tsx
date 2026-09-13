import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, normalizeSettings, settingsItem, type Settings } from '../../src/settings';
import type { ExportFormat } from '../../src/conversation/types';
import { zh } from '../../src/ui/zh';
import './style.css';

function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void settingsItem.getValue().then((value) => {
      if (active) { setSettings(normalizeSettings(value)); setLoaded(true); }
    }).catch(() => { if (active) setError(zh.settingsLoadError); });
    const unwatch = settingsItem.watch((value) => {
      if (active) setSettings(normalizeSettings(value));
    });
    return () => {
      active = false;
      unwatch?.();
    };
  }, []);

  const save = async (next: Settings) => {
    if (!loaded || saving) return;
    const normalized = normalizeSettings(next);
    const previous = settings;
    setSettings(normalized);
    setSaved(false);
    setSaving(true);
    setError(null);
    try {
      await settingsItem.setValue(normalized);
      setSettings(normalizeSettings(await settingsItem.getValue()));
      setSaved(true);
    } catch {
      setSettings(previous);
      setError(zh.settingsSaveError);
    } finally { setSaving(false); }
  };

  return (
    <main className="popup">
      <header>
        <h1>ChatPilot</h1>
        <p>{zh.popupSubtitle}</p>
      </header>
      <form onSubmit={(event) => event.preventDefault()}>
        <fieldset disabled={!loaded || saving}>
        <label className="popup-toggle">
          <span>
            <strong>{zh.navigatorEnabled}</strong>
            <small>{zh.navigatorEnabledHint}</small>
          </span>
          <input
            type="checkbox"
            aria-label={zh.navigatorEnabled}
            checked={settings.navigatorEnabled}
            onChange={(event) => void save({ ...settings, navigatorEnabled: event.target.checked })}
          />
        </label>
        <label className="popup-toggle">
          <span>
            <strong>{zh.smoothScroll}</strong>
            <small>{zh.smoothScrollHint}</small>
          </span>
          <input
            type="checkbox"
            aria-label={zh.smoothScroll}
            checked={settings.smoothScroll}
            onChange={(event) => void save({ ...settings, smoothScroll: event.target.checked })}
          />
        </label>
        <label>
          {zh.defaultExportFormat}
          <select
            value={settings.defaultExportFormat}
            onChange={(event) => void save({ ...settings, defaultExportFormat: event.target.value as ExportFormat })}
          >
            <option value="md">Markdown (.md)</option>
            <option value="json">JSON (.json)</option>
            <option value="txt">TXT (.txt)</option>
          </select>
        </label>
        <label>
          {zh.defaultExportScope}
          <select
            value={settings.defaultExportMode}
            onChange={(event) => void save({ ...settings, defaultExportMode: event.target.value === 'assistant' ? 'assistant' : 'all' })}
          >
            <option value="all">{zh.allMessages}</option>
            <option value="assistant">{zh.assistantMessages}</option>
          </select>
        </label>
        <label>
          {zh.navigatorWidth} <output>{settings.navigatorWidth}px</output>
          <input
            type="range"
            min="260"
            max="420"
            step="1"
            value={settings.navigatorWidth}
            onChange={(event) => void save({ ...settings, navigatorWidth: Number(event.target.value) })}
          />
        </label>
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
      <p className="popup-saved" role="status" aria-live="polite">{saving ? zh.saving : saved ? zh.saved : !loaded && !error ? zh.loading : ''}</p>
      <p className="popup-privacy">{zh.privacyNote}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('ChatPilot popup root was not found.');

createRoot(root).render(<Popup />);
