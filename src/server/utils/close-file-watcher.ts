import type { FSWatcher } from 'chokidar';

export function closeFileWatcher(watcher: FSWatcher): Promise<void> {
  const closing = watcher.close();
  // Chokidar removes all listeners during close(), but already pending I/O
  // can still emit errors afterwards. Retired watchers must absorb those.
  if (watcher.listenerCount('error') === 0) watcher.on('error', () => {});
  return closing;
}
