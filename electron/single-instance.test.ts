import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceSingleInstance } from './single-instance';

test('primary instance retains the lock and focuses its window on a second launch', () => {
  let secondInstanceHandler: (() => void) | undefined;
  let focusCount = 0;
  let quitCount = 0;

  const isPrimary = enforceSingleInstance(
    {
      requestSingleInstanceLock: () => true,
      quit: () => {
        quitCount += 1;
      },
      on: (event, handler) => {
        assert.equal(event, 'second-instance');
        secondInstanceHandler = handler;
      },
    },
    () => {
      focusCount += 1;
    },
  );

  assert.equal(isPrimary, true);
  assert.equal(quitCount, 0);
  assert.ok(secondInstanceHandler);

  secondInstanceHandler();
  assert.equal(focusCount, 1);
});

test('secondary instance quits without registering lifecycle handlers', () => {
  let registered = false;
  let focusCount = 0;
  let quitCount = 0;

  const isPrimary = enforceSingleInstance(
    {
      requestSingleInstanceLock: () => false,
      quit: () => {
        quitCount += 1;
      },
      on: () => {
        registered = true;
      },
    },
    () => {
      focusCount += 1;
    },
  );

  assert.equal(isPrimary, false);
  assert.equal(quitCount, 1);
  assert.equal(registered, false);
  assert.equal(focusCount, 0);
});
