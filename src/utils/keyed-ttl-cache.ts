/**
 * @fileoverview 通用「按键分桶 + 滑动 TTL + 容量上限」的内存缓存。
 *
 * @note 新增(线上服务重启-#5/#3): 抽取自 resources/index.ts 的 per-user UI 缓存，
 *   把「Map + 滑动过期 + 容量驱逐 + 过期清理」这套通用逻辑独立出来并单测，避免各处重复实现。
 *
 * 语义：
 * - 滑动 TTL：get 命中 与 set 均把该条目过期时间刷新为 now + ttlMs（活动即续期）。
 * - 容量上限：set 新键且已达 maxEntries 时，先清过期，仍超限则驱逐「最久未活动」（expiry 最小）的一条。
 * - cleanupExpired()：删除所有已过期条目，供定时器或测试手动调用。
 *
 * 说明：本 store 采用「活动滑动」过期语义，适合 UI 展示等「只要还在用就保留」的缓存。
 *   它并不适合「过期时间由存储值自身决定」的场景（如 auth session 的 refreshTokenExpiry），
 *   那类场景请勿改用本 store，以免把 token 过期语义误改成活动过期。
 */
export interface KeyedTtlStoreOptions {
  /** 条目存活时间（毫秒），每次 get/set 命中后重新计时 */
  ttlMs: number;
  /** 最大条目数，超过时驱逐最久未活动的条目 */
  maxEntries: number;
}

interface Entry<V> {
  value: V;
  /** 过期时间(ms epoch)，get/set 时刷新 */
  expiry: number;
}

export class KeyedTtlStore<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: KeyedTtlStoreOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
  }

  /** 读取；已过期视为未命中（顺手删除，不复活）；命中则滑动 TTL */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    /**
     * @note 纠正(#2): 定时清理只每 ttlMs 跑一次，逻辑过期到下次清理之间存在窗口。
     *   若不在此惰性判断过期，get 会返回并「复活」陈旧数据，使 TTL 形同虚设。
     *   与 ResponseCache.get()（rate-limiter.ts）行为对齐：过期即删、返回 undefined。
     */
    if (entry.expiry < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    entry.expiry = Date.now() + this.ttlMs;
    return entry.value;
  }

  /** 写入；滑动 TTL；新键超过容量上限时驱逐最久未活动的条目 */
  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      existing.expiry = Date.now() + this.ttlMs;
      return;
    }
    if (this.map.size >= this.maxEntries) {
      this.evictOne();
    }
    this.map.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }

  /** 删除所有已过期条目，返回删除数量 */
  cleanupExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiry < now) {
        this.map.delete(key);
        count++;
      }
    }
    return count;
  }

  /** 为腾出容量：先清过期，仍超限则驱逐 expiry 最小（最久未活动）的一条 */
  private evictOne(): void {
    this.cleanupExpired();
    if (this.map.size < this.maxEntries) return;
    let oldestKey: string | undefined;
    let oldestExpiry = Infinity;
    for (const [key, entry] of this.map) {
      if (entry.expiry < oldestExpiry) {
        oldestExpiry = entry.expiry;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.map.delete(oldestKey);
  }
}
