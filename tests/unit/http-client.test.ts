/**
 * @fileoverview HTTP Client 单元测试 (Mock fetch)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpClient, AuthExpiredError, setTokenGetter, getAuthHeaderName } from '../../src/api-client/http-client';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock env config
vi.mock('../../src/config/env', () => ({
  getEnvConfig: () => ({
    env: 'test',
    openApiBase: 'http://test002.cjdropshipping.offline.pre.com',
    webBase: 'http://www.cjdropshipping.offline.pre.com',
    loginApiBase: 'http://www.cjdropshipping.offline.pre.com',
    platform: 1,
    language: 'en',
    currency: 'USD',
    tokenEncryptKey: 'test-key',
  }),
}));

// Mock rate limiter
vi.mock('../../src/api-client/rate-limiter', () => ({
  rateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
    getRetryDelay: vi.fn((n: number) => 500 * Math.pow(2, n)),
    getMaxRetries: vi.fn().mockReturnValue(3),
  },
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    rateLimit: vi.fn(),
    request: vi.fn(),
  },
  isDebugMode: vi.fn(() => false),
}));

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient();
    mockFetch.mockReset();
    setTokenGetter(() => 'test-token-123');
  });

  it('发送 POST 请求带正确的 headers', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 200, result: true, message: 'Success', data: { id: 1 } }),
    });

    const result = await client.request('/product/query', {
      body: { keyword: 'test' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api2.0/v1/product/query');
    expect(options.method).toBe('POST');
    expect(options.headers['CJ-Access-Token']).toBe('test-token-123');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(result.code).toBe(200);
    expect(result.data).toEqual({ id: 1 });
  });

  it('本地 MCP/web login token 使用 token header 而不是 CJ-Access-Token', async () => {
    setTokenGetter(() => 'MCP@CJ123456@L5@CJ:redacted-jwt');
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 0, success: true, message: null, data: [] }),
    });

    await client.request('/product/globalWarehouseList', { method: 'GET' });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.token).toBe('MCP@CJ123456@L5@CJ:redacted-jwt');
    expect(options.headers['CJ-Access-Token']).toBeUndefined();
  });

  it('sélecteur de header auth distingue token MCP et token OpenAPI', () => {
    expect(getAuthHeaderName('MCP@CJ123456@L5@CJ:redacted-jwt')).toBe('token');
    expect(getAuthHeaderName('USR@CJ123456@L5@CJ:redacted-jwt')).toBe('token');
    expect(getAuthHeaderName('plain-openapi-access-token')).toBe('CJ-Access-Token');
  });

  it('skipAuth 时不携带 token', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 200, result: true, message: 'Success', data: {} }),
    });

    await client.request('/authentication/getAccessToken', { skipAuth: true });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['CJ-Access-Token']).toBeUndefined();
  });

  it('401/1600100 抛出 AuthExpiredError', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 1600100, result: false, message: 'Token expired', data: null }),
    });

    await expect(client.request('/product/query')).rejects.toThrow(AuthExpiredError);
  });

  it('GET 请求不携带 body', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 200, result: true, data: [] }),
    });

    await client.request('/product/globalWarehouseList', { method: 'GET' });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBeUndefined();
  });

  it.each([401, 429])('preserves HTTP %s and provider envelope for discovery without replay', async status => {
    const envelope = { code: status, result: false, message: status === 401 ? 'Unauthorized' : 'Quota exceeded', data: null, requestId: 'receipt', pointsInfo: { remaining: 0 } };
    mockFetch.mockResolvedValue({ status, json: async () => envelope });
    expect(await client.request('/product/queryProductsByImage', { retry: false, preserveErrors: true })).toEqual({ ...envelope, httpStatus: status });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not replay expensive calls after uncertain network or non-JSON failures', async () => {
    mockFetch.mockRejectedValue(new Error('Network interrupted'));
    await expect(client.request('/product/queryProductsByImage', { retry: false, preserveErrors: true })).rejects.toThrow('Network interrupted');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockReset().mockResolvedValue({ status: 502, json: async () => { throw new Error('Invalid JSON'); } });
    await expect(client.request('/product/queryProductsByImage', { retry: false, preserveErrors: true })).rejects.toThrow('Invalid JSON');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('params 附加到 URL query string', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ code: 200, result: true, data: {} }),
    });

    await client.request('/product/query', { params: { lang: 'en' } });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('lang=en');
  });
});
