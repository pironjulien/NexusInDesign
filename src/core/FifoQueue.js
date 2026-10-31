export class QueueFullError extends Error {
  constructor() {
    super('La file InDesign est pleine; réessayez après la fin des commandes en cours.');
    this.name = 'QueueFullError';
  }
}

export class FifoQueue {
  constructor({ maxLength = 100 } = {}) {
    this.maxLength = maxLength;
    this.items = [];
    this.running = false;
  }

  get length() {
    return this.items.length + (this.running ? 1 : 0);
  }

  enqueue(operation) {
    if (this.items.length >= this.maxLength) return Promise.reject(new QueueFullError());
    return new Promise((resolve, reject) => {
      this.items.push({ operation, resolve, reject });
      void this.#drain();
    });
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift();
        try {
          item.resolve(await item.operation());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
