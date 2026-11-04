// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
'use strict';
const crypto = require('node:crypto');
// Count UTF-8 payload bytes, not JSON framing or UTF-16 string length. A fresh
// subscription id keeps delayed callbacks from acknowledging a later attach.
const OUTPUT_HIGH_BYTES = 256 * 1024;
const OUTPUT_LOW_BYTES = 64 * 1024;
const OUTPUT_HARD_BYTES = 1024 * 1024;
const OUTPUT_STALL_MS = 2000;
const OUTPUT_PAUSE_MAX_MS = 10000;

class OutputWindow {
  id = crypto.randomUUID();
  sent = 0;
  acknowledged = 0;
  blocked = false;

  get pending() {
    return this.sent - this.acknowledged;
  }

  /** @param {number} bytes */
  write(bytes) {
    this.sent += bytes;
    if (this.pending >= OUTPUT_HIGH_BYTES) this.blocked = true;
    return this.sent;
  }

  /** @param {string} id @param {number} offset */
  acknowledge(id, offset) {
    if (id !== this.id || !Number.isSafeInteger(offset) || offset < 0 || offset > this.sent)
      return false;
    // Duplicate and out-of-order ACKs cannot release credit twice.
    this.acknowledged = Math.max(this.acknowledged, offset);
    if (this.pending <= OUTPUT_LOW_BYTES) this.blocked = false;
    return true;
  }
}

module.exports = {
  OutputWindow,
  OUTPUT_HIGH_BYTES,
  OUTPUT_LOW_BYTES,
  OUTPUT_HARD_BYTES,
  OUTPUT_STALL_MS,
  OUTPUT_PAUSE_MAX_MS,
};
