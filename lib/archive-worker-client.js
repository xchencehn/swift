'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// One outstanding command per worker. Background readers cannot queue an
// entire dashboard ahead of a newly selected conversation.
class ArchiveWorkerClient {
  constructor(filename, workerData) {
    this.filename = filename;
    this.workerData = workerData;
    this.queue = [];
    this.nextId = 0;
    this.closed = false;
  }
  request(payload, priority = 0) {
    if (this.closed)
      return Promise.reject(
        Object.assign(new Error('存档读取器已关闭。'), { code: 'ARCHIVE_STORE_CLOSED' }),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, payload, priority, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this.dispatch();
    });
  }
  start() {
    if (this.worker) return this.worker;
    const worker = (this.worker = new Worker(path.join(__dirname, this.filename), {
      workerData: this.workerData,
    }));
    const failed = (error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      const job = this.current;
      this.current = null;
      job?.reject(
        Object.assign(new Error('存档读取暂时中断，请重试。'), {
          code: 'ARCHIVE_WORKER_FAILED',
          cause: error,
        }),
      );
      if (!this.closed) this.dispatch();
    };
    worker.on('error', failed);
    worker.on('exit', (code) => failed(new Error(`Archive worker exited: ${code}`)));
    worker.on('message', ({ id, result, error }) => {
      const job = this.current;
      if (!job || job.id !== id) return;
      this.current = null;
      worker.unref();
      if (error) job.reject(Object.assign(new Error(error.message), error));
      else job.resolve(result);
      this.dispatch();
    });
    worker.unref();
    return worker;
  }
  dispatch() {
    if (this.closed || this.current || !this.queue.length) return;
    const job = (this.current = this.queue.shift()),
      worker = this.start();
    worker.ref();
    worker.postMessage({ id: job.id, ...job.payload });
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0))
      job.reject(Object.assign(new Error('存档读取器已关闭。'), { code: 'ARCHIVE_STORE_CLOSED' }));
    if (this.worker) await this.worker.terminate();
  }
}
module.exports = { ArchiveWorkerClient };
