'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { applyOutboxUpdate } = require('../public/chat/container').create({});

test('native acceptance survives wall-clock rollback and stale unaccepted polls', () => {
  const message = {
    id: 'retry',
    status: 'failed',
    updatedAt: 2000,
    deliveryUncertain: false,
    error: { code: 'SIDE_UNKNOWN' },
  };
  const accepted = {
    id: 'retry',
    status: 'dispatched',
    updatedAt: 1000,
    transportAcceptedAt: 1000,
    deliveryUncertain: false,
    error: null,
  };
  applyOutboxUpdate(message, accepted);
  assert.equal(message.status, 'dispatched');
  assert.equal(message.transportAcceptedAt, 1000);
  for (const status of ['queued', 'sending', 'failed']) {
    applyOutboxUpdate(message, { id: 'retry', status, updatedAt: 2000, transportAcceptedAt: null });
    assert.equal(message.status, 'dispatched');
    assert.equal(message.transportAcceptedAt, 1000);
  }
  applyOutboxUpdate(message, {
    id: 'retry',
    status: 'consumed',
    updatedAt: 3000,
    transportAcceptedAt: 1000,
  });
  applyOutboxUpdate(message, accepted);
  assert.equal(message.status, 'consumed');
});

test('clock recovery preserves discarded history and rejects ordinary older failures', () => {
  const discarded = { status: 'discarded', updatedAt: 2000 };
  applyOutboxUpdate(discarded, {
    status: 'dispatched',
    updatedAt: 1000,
    transportAcceptedAt: 1000,
  });
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.transportAcceptedAt, undefined);
  const failed = { status: 'failed', updatedAt: 2000, error: { code: 'SIDE_UNKNOWN' } };
  applyOutboxUpdate(failed, { status: 'queued', updatedAt: 1000 });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'SIDE_UNKNOWN');
});

test('a newer retry overrides an earlier failure when the clock moves back', () => {
  const message = { id: 'retry', status: 'failed', attempts: 1, updatedAt: 2000, retryable: false };
  applyOutboxUpdate(message, {
    id: 'retry',
    status: 'failed',
    attempts: 2,
    updatedAt: 1000,
    retryable: true,
  });
  assert.equal(message.attempts, 2);
  assert.equal(message.retryable, true);
  applyOutboxUpdate(message, {
    id: 'retry',
    status: 'failed',
    attempts: 1,
    updatedAt: 3000,
    retryable: false,
  });
  assert.equal(message.attempts, 2);
  assert.equal(message.retryable, true);
  applyOutboxUpdate(message, {
    id: 'retry',
    status: 'dispatched',
    attempts: 1,
    updatedAt: 500,
    transportAcceptedAt: 500,
  });
  assert.equal(message.status, 'dispatched');
  applyOutboxUpdate(message, {
    id: 'retry',
    status: 'failed',
    attempts: 3,
    updatedAt: 4000,
    transportAcceptedAt: null,
  });
  assert.equal(message.status, 'dispatched');
});
