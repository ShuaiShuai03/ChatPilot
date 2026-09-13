import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ChatPilotController, ConversationView, ExportFormat, ExportMode, MessageRecord } from '../conversation/types';
import type { Settings } from '../settings';
import { zh } from '../ui/zh';
import './navigator.css';

export interface NavigatorProps {
  controller: ChatPilotController;
  settings: Settings;
}

interface MessageRowProps {
  message: MessageRecord;
  checked: boolean;
  current: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
  onNavigate: (id: string) => void;
}

function roleLabel(role: MessageRecord['role']): string {
  return role === 'user' ? zh.userRole : zh.assistantRole;
}

const MessageRow = memo(function MessageRow({
  message,
  checked,
  current,
  disabled,
  onToggle,
  onNavigate,
}: MessageRowProps) {
  const preview = message.preview || message.text.replace(/\s+/g, ' ').trim();
  const rowLabel = `${roleLabel(message.role)}的第 ${message.index} 条消息`;

  return (
    <li className="chatpilot-message" data-testid="chatpilot-message" aria-current={current ? 'true' : undefined}>
      <label className="chatpilot-message__select">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={`${zh.selectMessage}${rowLabel}`}
          onChange={() => onToggle(message.id)}
        />
      </label>
      <button
        type="button"
        className="chatpilot-message__navigate"
        disabled={disabled}
        aria-label={`${zh.goToMessage}${rowLabel}`}
        onClick={() => onNavigate(message.id)}
      >
        <span className="chatpilot-message__meta">{roleLabel(message.role)} · {message.index}</span>
        <span className="chatpilot-message__preview">{preview || zh.emptyMessage}</span>
      </button>
    </li>
  );
});

function scopedMessageCount(total: number, assistantCount: number, selectedCount: number, mode: ExportMode): number {
  if (mode === 'assistant') return assistantCount;
  if (mode === 'selected') return selectedCount;
  return total;
}

interface CompactFeedbackProps {
  snapshot: ConversationView;
  controller: ChatPilotController;
  onReindex: () => void;
}

function CompactFeedback({ snapshot, controller, onReindex }: CompactFeedbackProps) {
  if (!snapshot.busy && !snapshot.error && !snapshot.needsReindex) return null;

  return (
    <section className="chatpilot-compact-feedback" aria-label={zh.status}>
      {snapshot.error ? <p className="chatpilot-error" role="alert">{snapshot.error}</p> : null}
      {snapshot.busy ? (
        <div className="chatpilot-progress" role="status">
          <span>{snapshot.progress || zh.working}</span>
          <button type="button" onClick={() => controller.cancel()}>{zh.cancel}</button>
        </div>
      ) : null}
      {snapshot.needsReindex ? (
        <button type="button" className="chatpilot-load-button" disabled={snapshot.busy} onClick={onReindex}>{zh.reindexConversation}</button>
      ) : null}
    </section>
  );
}

/**
 * Conversation navigator rendered by the content entrypoint inside its shadow root.
 * It owns only presentational state; all conversation work stays in `controller`.
 */
export function Navigator({ controller, settings }: NavigatorProps) {
  const snapshot = useSyncExternalStore(
    controller.store.subscribe,
    controller.store.getSnapshot,
    controller.store.getSnapshot,
  );
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState<ExportFormat>(settings.defaultExportFormat);
  const [mode, setMode] = useState<ExportMode>(settings.defaultExportMode);
  const railButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnFocusToRail = useRef(false);

  useEffect(() => {
    setFormat(settings.defaultExportFormat);
    setMode(settings.defaultExportMode);
  }, [settings.defaultExportFormat, settings.defaultExportMode]);

  useEffect(() => {
    if (expanded) {
      searchRef.current?.focus();
    } else if (returnFocusToRail.current) {
      railButtonRef.current?.focus();
      returnFocusToRail.current = false;
    }
  }, [expanded]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleMessages = useMemo(() => {
    if (!normalizedQuery) return snapshot.messages;
    return snapshot.messages.filter((message) => message.text.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, snapshot.messages]);
  const selectedCount = snapshot.selectedIds.size;
  const assistantCount = useMemo(
    () => snapshot.messages.filter((message) => message.role === 'assistant').length,
    [snapshot.messages],
  );
  const eligibleCount = scopedMessageCount(snapshot.messages.length, assistantCount, selectedCount, mode);
  const style = { '--chatpilot-width': `${settings.navigatorWidth}px` } as CSSProperties;
  const selectedScopeIsEmpty = mode === 'selected' && selectedCount === 0;

  const toggle = useCallback((id: string) => controller.store.toggleSelection(id), [controller]);
  const navigate = useCallback((id: string) => {
    void controller.navigate(id);
  }, [controller]);
  const applySelection = (selection: 'all' | 'none' | 'user' | 'assistant') => {
    if (!snapshot.busy) controller.store.select(selection);
  };
  const runMaterialize = () => {
    void controller.materialize();
  };
  const runExport = () => {
    void controller.export(format, mode);
  };
  const runReindex = () => controller.reindex();
  const navigateUser = (direction: 'previous' | 'next') => {
    void controller.navigateUser(direction);
  };
  const openPanel = () => setExpanded(true);
  const closePanel = () => {
    returnFocusToRail.current = true;
    setExpanded(false);
  };

  if (!settings.navigatorEnabled) return null;

  return (
    <aside
      className={`chatpilot-navigator${expanded ? ' chatpilot-navigator--expanded' : ''}`}
      style={style}
      aria-label={zh.navigatorLabel}
      data-testid="chatpilot-root"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <div className="chatpilot-layout">
        {expanded ? (
          <section className="chatpilot-panel" aria-label={zh.navigatorLabel}>
            <header className="chatpilot-panel__header">
              <div>
                <h2>ChatPilot</h2>
                <p>{snapshot.messages.length} 条消息 · 已选 {selectedCount} 条</p>
              </div>
              <button type="button" className="chatpilot-icon-button" aria-label={zh.closeNavigator} onClick={closePanel}>×</button>
            </header>

            <div className="chatpilot-search">
              <label htmlFor="chatpilot-search">{zh.searchMessages}</label>
              <input
                id="chatpilot-search"
                type="search"
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={zh.searchPlaceholder}
              />
            </div>

            <div className="chatpilot-selection-controls" role="group" aria-label={zh.selectionControls}>
              <button type="button" disabled={snapshot.busy} onClick={() => applySelection('all')}>{zh.selectAll}</button>
              <button type="button" disabled={snapshot.busy} onClick={() => applySelection('none')}>{zh.clear}</button>
              <button type="button" disabled={snapshot.busy} onClick={() => applySelection('user')}>{zh.userOnly}</button>
              <button type="button" disabled={snapshot.busy} onClick={() => applySelection('assistant')}>{zh.assistantOnly}</button>
            </div>

            <div className="chatpilot-content">
              {snapshot.error || snapshot.needsReindex ? (
                <div className="chatpilot-content__notices">
                  {snapshot.error ? <p className="chatpilot-error" role="alert">{snapshot.error}</p> : null}
                  {snapshot.needsReindex ? <button type="button" className="chatpilot-load-button" disabled={snapshot.busy} onClick={runReindex}>{zh.reindexConversation}</button> : null}
                </div>
              ) : null}
              <div className="chatpilot-message-list-wrap">
                {visibleMessages.length ? (
                  <ol className="chatpilot-message-list" aria-label={zh.discoveredMessages}>
                    {visibleMessages.map((message) => (
                      <MessageRow
                        key={message.id}
                        message={message}
                        checked={snapshot.selectedIds.has(message.id)}
                        current={snapshot.currentId === message.id}
                        disabled={snapshot.busy}
                        onToggle={toggle}
                        onNavigate={navigate}
                      />
                    ))}
                  </ol>
                ) : (
                  <p className="chatpilot-empty">
                    {snapshot.messages.length === 0 ? zh.noConversation : zh.noSearchResults}
                  </p>
                )}
              </div>
            </div>

            <footer className="chatpilot-panel__footer">
              {snapshot.busy ? (
                <div className="chatpilot-progress" role="status">
                  <span>{snapshot.progress || zh.working}</span>
                  <button type="button" onClick={() => controller.cancel()}>{zh.cancel}</button>
                </div>
              ) : (
                <button type="button" className="chatpilot-load-button" disabled={snapshot.needsReindex} onClick={runMaterialize}>{zh.loadConversation}</button>
              )}
              <div className="chatpilot-export" aria-label={zh.exportConversation}>
                <label>
                  {zh.exportFormat}
                  <select value={format} disabled={snapshot.busy} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
                    <option value="md">Markdown (.md)</option>
                    <option value="json">JSON (.json)</option>
                    <option value="txt">TXT (.txt)</option>
                  </select>
                </label>
                <label>
                  {zh.exportScope}
                  <select value={mode} disabled={snapshot.busy} onChange={(event) => setMode(event.target.value as ExportMode)}>
                    <option value="all">{zh.allMessages}</option>
                    <option value="assistant">{zh.assistantMessages}</option>
                    <option value="selected">{zh.selectedMessages}</option>
                  </select>
                </label>
                <button type="button" className="chatpilot-export-button" disabled={snapshot.busy || eligibleCount === 0} onClick={runExport}>{zh.export}</button>
                {selectedScopeIsEmpty ? <p className="chatpilot-export-help">{zh.selectOneMessage}</p> : null}
              </div>
            </footer>
          </section>
        ) : (
          <CompactFeedback snapshot={snapshot} controller={controller} onReindex={runReindex} />
        )}
        <div className="chatpilot-direction-controls" role="group" aria-label={zh.userNavigation}>
          <button
            type="button"
            className="chatpilot-direction-button"
            aria-label={zh.previousUser}
            title={zh.previousUser}
            disabled={snapshot.busy || snapshot.needsReindex || !snapshot.userNavigation.canPrevious}
            onClick={() => navigateUser('previous')}
          >
            ↑
          </button>
          <button
            type="button"
            className="chatpilot-direction-button"
            aria-label={zh.nextUser}
            title={zh.nextUser}
            disabled={snapshot.busy || snapshot.needsReindex || !snapshot.userNavigation.canNext}
            onClick={() => navigateUser('next')}
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          className="chatpilot-rail-button"
          aria-expanded={expanded}
          hidden={expanded}
          aria-label={zh.openNavigator}
          ref={railButtonRef}
          onClick={openPanel}
        >
          <span className="chatpilot-rail-button__label">{zh.openNavigator}</span>
          <span className="chatpilot-count" aria-hidden="true">{snapshot.messages.length}</span>
        </button>
      </div>
    </aside>
  );
}

export default Navigator;
