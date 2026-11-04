// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
(function (root) {
  /** The part of a `Worker` the queue uses, so a test can stand in for one. */

  /** A request sent to a worker, and what it answers. */

  /** A job queued for a worker. Its promise never rejects: a job that fails, runs over or is cancelled gives `null`. */

  /**
   * Work that may take long, done one job at a time in a worker so the page never waits for it. A
   * job gets `budgetMs` from its start: past it the worker is ended (a tokenizer stuck in a quadratic
   * input cannot be interrupted any other way), the job gives `null`, and the next job starts a new
   * worker. The worker is started on the first job, not before.
   */
  function createOffThreadQueue(spawn, budgetMs, { waitForReady = false } = {}) {
    let worker = null;
    let running = null;
    let ready = !waitForReady;
    let initializationTimer;
    const waiting = [];
    let nextId = 1;

    const initializationFailed = () => {
      clearTimeout(initializationTimer);
      worker?.terminate();
      worker = null;
      for (const job of waiting.splice(0)) job.resolve(null);
    };

    /** Ends the running job with `result`; `stop` also ends its worker, which is then replaced. */
    const finish = (result, stop) => {
      if (running === null) return;
      clearTimeout(running.timer);
      const { resolve } = running;
      running = null;
      if (stop && worker !== null) {
        worker.terminate();
        worker = null;
      }
      resolve(result);
      pump();
    };

    /** Starts the next waiting job, if none runs. */
    const pump = () => {
      if (running !== null) return;
      if (!waiting.length) return;
      if (worker === null) {
        try {
          worker = spawn();
          ready = !waitForReady;
        } catch {
          waiting.shift().resolve(null);
          pump();
          return;
        }
        const owner = worker;
        if (waitForReady) {
          // Loading a local worker and its library is separate from executing a job.
          // Neither phase blocks the page; initialization and parsing stay bounded.
          initializationTimer = setTimeout(() => {
            if (worker === owner) initializationFailed();
          }, 5000);
        }
        worker.onmessage = (event) => {
          const answer = event.data;
          if (worker !== owner) return;
          if (waitForReady && answer?.ready === true) {
            clearTimeout(initializationTimer);
            ready = true;
            pump();
            return;
          }
          if (worker === owner && running !== null && answer?.id === running.id)
            finish(answer.result, false);
        };
        worker.onerror = () => {
          if (worker !== owner) return;
          if (running !== null) finish(null, true);
          else initializationFailed();
        };
      }
      if (!ready) return;
      const next = waiting.shift();
      running = { ...next, timer: setTimeout(() => finish(null, true), budgetMs) };
      try {
        worker.postMessage({ id: next.id, request: next.request }, next.transfer);
      } catch {
        finish(null, true);
      }
    };

    return (request, transfer = []) => {
      let entry;
      const promise = new Promise((resolve) => {
        entry = { id: nextId++, request, transfer, resolve };
      });
      if (waiting.length >= 32) {
        entry.resolve(null);
        return { promise, cancel: () => false };
      }
      waiting.push(entry);
      pump();
      return {
        promise,
        cancel: () => {
          const index = waiting.indexOf(entry);
          if (index < 0) return false;
          waiting.splice(index, 1);
          entry.resolve(null);
          return true;
        },
      };
    };
  }

  /**
   * The worker's side: answers each request with `handle`'s result, and with `null` when it throws
   * (a stack overflow in a parser included). `handle` may name buffers to hand over without a copy.
   */
  function serveOffThread(handle) {
    const scope = globalThis;
    scope.onmessage = (event) => {
      const { id, request } = event.data;
      let answer;
      try {
        answer = handle(request);
      } catch {
        answer = { result: null };
      }
      scope.postMessage({ id, result: answer.result }, answer.transfer ?? []);
    };
  }

  const api = { createOffThreadQueue, serveOffThread };
  if (typeof module === 'object') module.exports = api;
  else root.StudioOffThread = api;
})(globalThis);
