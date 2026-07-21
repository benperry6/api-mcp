import { describe, expect, it, vi } from 'vitest';
import { KeyedTtlStore } from '../../src/utils/keyed-ttl-cache.js';

describe('KeyedTtlStore', () => {
  it('get 命中会滑动 TTL：持续读取的条目不会过期', () => {
    vi.useFakeTimers();
    try {
      const s = new KeyedTtlStore<number>({ ttlMs: 1000, maxEntries: 10 });
      s.set('a', 1);
      vi.advanceTimersByTime(800);
      expect(s.get('a')).toBe(1); // 读取滑动到 now+1000
      vi.advanceTimersByTime(800); // 距 set 已 1600ms，距上次 get 仅 800ms
      expect(s.cleanupExpired()).toBe(0); // 仍在
      expect(s.get('a')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanupExpired 删除超过 TTL 且未再访问的条目', () => {
    vi.useFakeTimers();
    try {
      const s = new KeyedTtlStore<number>({ ttlMs: 1000, maxEntries: 10 });
      s.set('a', 1);
      vi.advanceTimersByTime(1500);
      expect(s.cleanupExpired()).toBe(1);
      expect(s.get('a')).toBeUndefined();
      expect(s.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超过 maxEntries 时驱逐「最久未活动」的条目（get 视为活动）', () => {
    vi.useFakeTimers();
    try {
      const s = new KeyedTtlStore<number>({ ttlMs: 10_000, maxEntries: 3 });
      s.set('a', 1);
      vi.advanceTimersByTime(1);
      s.set('b', 2);
      vi.advanceTimersByTime(1);
      s.set('c', 3);
      vi.advanceTimersByTime(1);
      // 访问 a → a 变最近活动，b 成为最久未活动
      expect(s.get('a')).toBe(1);
      vi.advanceTimersByTime(1);
      s.set('d', 4); // 触发驱逐

      expect(s.size()).toBe(3);
      expect(s.get('b')).toBeUndefined(); // b 被驱逐
      expect(s.get('a')).toBe(1);
      expect(s.get('c')).toBe(3);
      expect(s.get('d')).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('set 已存在的 key 只更新值并滑动 TTL，不新增条目', () => {
    const s = new KeyedTtlStore<number>({ ttlMs: 1000, maxEntries: 10 });
    s.set('a', 1);
    s.set('a', 2);
    expect(s.size()).toBe(1);
    expect(s.get('a')).toBe(2);
  });

  it('get 不返回已过期条目：未清理也视为 miss，并顺手删除（不复活）', () => {
    vi.useFakeTimers();
    try {
      const s = new KeyedTtlStore<number>({ ttlMs: 1000, maxEntries: 10 });
      s.set('a', 1);
      vi.advanceTimersByTime(1500); // 已过期，但未调用 cleanupExpired
      expect(s.get('a')).toBeUndefined(); // 视为 miss，不发陈旧数据
      expect(s.size()).toBe(0); // 且顺手删除，不因读取而复活
    } finally {
      vi.useRealTimers();
    }
  });
});
