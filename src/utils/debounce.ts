/** Coalesce DOM work, then yield to idle time without allowing continuous changes to starve it. */
export function createIdleBatch(callback: () => void, wait = 100): { schedule(): void; flush(): void; cancel(): void } {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let firstAt = 0;
  const host = globalThis;
  function cancel(): void {
    if (timeout !== undefined) clearTimeout(timeout);
    if (idle !== undefined && typeof host.cancelIdleCallback === 'function') host.cancelIdleCallback(idle);
    timeout = undefined;
    idle = undefined;
    firstAt = 0;
  }
  function flush(): void { cancel(); callback(); }
  function schedule(): void {
    if (idle !== undefined) return;
    if (!firstAt) firstAt = Date.now();
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = undefined;
      if (typeof host.requestIdleCallback === 'function') idle = host.requestIdleCallback(flush, { timeout: 250 });
      else flush();
    }, Math.max(0, Math.min(wait, 400 - (Date.now() - firstAt))));
  }
  return { schedule, flush, cancel };
}
