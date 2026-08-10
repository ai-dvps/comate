import type { ChildProcess } from 'node:child_process';

/**
 * Capture process completion immediately after spawn so cleanup cannot miss
 * the close event while waiting for the child to release its stdio handles.
 */
export function waitForChildProcessClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onClose = () => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off('close', onClose);
      reject(error);
    };
    child.once('close', onClose);
    child.once('error', onError);
  });
}
