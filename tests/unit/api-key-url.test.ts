/**
 * @fileoverview 直连 Token 会话单元测试
 * 覆盖：
 *  1. 无认证上下文时 getSession 返回 null（本地模式）
 *  2. 直接 Token 模式（/mcp/API@userId@CJ:token）：getSession 合成 session、
 *     ensureAccessToken 直接返回 token、isSessionValid=true
 * @note 下线 apiKey 登录(E1): apiKey URL 会话隔离用例随之移除。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData } from '../../src/auth/session';

// ---------- mock token-store（避免文件 I/O） ----------
vi.mock('../../src/auth/token-store', () => ({
  TokenStore: class {
    static getInstance() { return new this(); }
    getToken() { return ''; }
    setToken() { /* noop */ }
    clearToken() { /* noop */ }
    hasToken() { return false; }
  },
}));

// ---------- mock http-client（避免真实 API 调用） ----------
vi.mock('../../src/api-client/http-client', () => ({
  httpClient: { request: vi.fn() },
}));

// ---------- mock env ----------
vi.mock('../../src/config/env', () => ({
  getEnvConfig: () => ({
    env: 'test', openApiBase: '', webBase: '', loginApiBase: '',
    platform: 1, language: 'en', currency: 'USD', tokenEncryptKey: '',
  }),
}));

// 动态 import 确保 mock 先行
const { getSession, clearSession, ensureAccessToken, isSessionValid } = await import('../../src/auth/session');
const { directTokenStorage } = await import('../../src/auth/api-key-context');

describe('本地模式回归', () => {
  beforeEach(() => { clearSession(); });

  it('无认证上下文时 getSession 返回 null', () => {
    expect(getSession()).toBeNull();
  });
});

describe('直接 Token 模式（/mcp/API@userId@CJ:token）', () => {
  it('getSession 返回合成 session，email=userId', async () => {
    let result: SessionData | null = null;
    await directTokenStorage.run({ userId: 'CJ4623764', accessToken: 'fake-jwt-token' }, async () => {
      result = getSession();
    });
    expect(result).not.toBeNull();
    expect(result?.email).toBe('CJ4623764');
    expect(result?.accessToken).toBe('fake-jwt-token');
  });

  it('ensureAccessToken 直接返回 token，不调用 API', async () => {
    let token: string | null = null;
    await directTokenStorage.run({ userId: 'CJ1234567', accessToken: 'direct-access-token-xyz' }, async () => {
      token = await ensureAccessToken();
    });
    expect(token).toBe('direct-access-token-xyz');
  });

  it('isSessionValid 返回 true', async () => {
    let valid: boolean | undefined;
    await directTokenStorage.run({ userId: 'CJ9999', accessToken: 'some-token' }, async () => {
      valid = isSessionValid();
    });
    expect(valid).toBe(true);
  });
});
