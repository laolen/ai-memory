// 可配置并发度的请求队列（v1.18.0 #4）：信号量 + FIFO 缓冲区。
// 单 GPU：maxConcurrent=1（串行）；多 GPU：maxConcurrent=N（并发至多 N）。
// 满队列时新请求被拒绝（429），调用方感知后延迟重试。
const config = require('./config');
const errC = config.errStats;

class RequestQueue {
  constructor(name, opts = {}) {
    this.name = name;
    this.maxConcurrent = opts.maxConcurrent || 1;
    this.maxSize = opts.maxSize || 100;
    this._active = 0;
    this._buffer = [];
    this._totalQueued = 0;
    this._totalRejected = 0;
  }

  // 入队：fn 为 async () => result。返回值：{ ok, result, error } 或 { ok:false, error:'queue_full' }
  async enqueue(fn) {
    if (this._buffer.length >= this.maxSize) {
      this._totalRejected++;
      return { ok: false, error: 'queue_full', retry_after: 1 };
    }
    if (this._active < this.maxConcurrent) {
      return this._execute(fn);
    }
    // 等待
    return new Promise((resolve) => {
      this._buffer.push({ fn, resolve });
      this._totalQueued++;
    });
  }

  async _execute(fn) {
    this._active++;
    try {
      const result = await fn();
      this._active--;
      this._dequeue();
      return { ok: true, result };
    } catch (error) {
      this._active--;
      this._dequeue();
      return { ok: false, error: error.message || String(error) };
    }
  }

  _dequeue() {
    while (this._buffer.length > 0 && this._active < this.maxConcurrent) {
      const next = this._buffer.shift();
      this._execute(next.fn).then((r) => next.resolve(r));
    }
  }

  status() {
    return {
      name: this.name,
      active: this._active,
      queued: this._buffer.length,
      maxConcurrent: this.maxConcurrent,
      maxSize: this.maxSize,
      totalQueued: this._totalQueued,
      totalRejected: this._totalRejected,
    };
  }
}

// 全局 Embed / LLM 队列实例
const C = config.CONFIG;
const embedQueue = new RequestQueue('embed', {
  maxConcurrent: C.embedding_max_concurrent,
  maxSize: C.queue_max_size,
});
const llmQueue = new RequestQueue('llm', {
  maxConcurrent: C.llm_max_concurrent,
  maxSize: C.queue_max_size,
});

module.exports = { RequestQueue, embedQueue, llmQueue };
