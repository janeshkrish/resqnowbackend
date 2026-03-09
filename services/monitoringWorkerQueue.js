export class MonitoringWorkerQueue {
  constructor({ concurrency = 16 } = {}) {
    const parsedConcurrency = Number(concurrency);
    this.concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
      ? Math.floor(parsedConcurrency)
      : 16;
  }

  async process(items, handler) {
    const queueItems = Array.isArray(items) ? items : [];
    if (queueItems.length === 0) {
      return { processed: 0, failed: 0, errors: [] };
    }

    const errors = [];
    let cursor = 0;
    let failed = 0;
    let processed = 0;

    const runWorker = async () => {
      while (cursor < queueItems.length) {
        const index = cursor++;
        const item = queueItems[index];
        try {
          await handler(item, index);
          processed += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            index,
            message: error?.message || "Monitoring worker failed.",
          });
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, queueItems.length) }, () => runWorker());
    await Promise.all(workers);

    return { processed, failed, errors };
  }
}
