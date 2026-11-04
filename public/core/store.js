'use strict';

/**
 * Client state and the sync cursor.
 *
 * The store holds the page's own state object and the position it has reached
 * in the service's event log. Its job is deciding whether an incoming change
 * notification can be ignored, which is the difference between a page that
 * refetches on every unrelated agent's activity and one that does not.
 *
 * 🔑 Skipping is only allowed when the store can prove the change is
 * irrelevant: the notification must describe the outbox, its sequence must
 * follow the one already seen, and the current pane must be absent from it.
 * A gap in sequence numbers means changes were missed, so it refetches.
 * Notifications without detail always refetch, and the periodic poll stays as
 * the fallback for the seconds around a reconnect when no event arrives.
 */
window.StudioStore = {
  create(initialState = {}) {
    const state = initialState;
    const listeners = new Set();
    let cursor = 0;

    /** Advance to `seq`, reporting whether it directly follows the last one. */
    function advance(seq) {
      if (!Number.isInteger(seq) || seq <= 0) return { contiguous: false };
      const contiguous = cursor > 0 && seq === cursor + 1;
      cursor = Math.max(cursor, seq);
      return { contiguous };
    }

    /** True when this notification provably does not affect `paneId`. */
    function skippable(message, paneId) {
      if (!message || message.scope !== 'outbox' || !Array.isArray(message.paneIds)) return false;
      const { contiguous } = advance(message.seq);
      if (!contiguous) return false;
      return Boolean(paneId) && !message.paneIds.includes(paneId);
    }

    /** Reset the cursor: a reconnect or a reset response invalidates it. */
    function resetCursor(seq = 0) {
      cursor = Number.isInteger(seq) && seq > 0 ? seq : 0;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    function notify(change) {
      for (const listener of [...listeners]) {
        try {
          listener(change, state);
        } catch (error) {
          console.error('[store]', error);
        }
      }
    }

    return {
      state,
      subscribe,
      notify,
      skippable,
      advance,
      resetCursor,
      get cursor() {
        return cursor;
      },
    };
  },
};
