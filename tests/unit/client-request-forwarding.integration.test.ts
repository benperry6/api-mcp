/**
 * @fileoverview 客户端原始请求头「over-the-wire」集成测试（真实本地后端 + 真实 fetch）
 *
 * @note 新增(第1次提交 / 26年07月19日): 端到端验证入站 x-real-ip 一路透传到出站 client-request-ip。
 *   不 mock fetch，而是启动一个真实的本地 HTTP 后端捕获收到的 header，
 *   模拟 index.ts 入口的组合：extractClientRequestContext(req.headers) →
 *   clientRequestStorage.run(ctx, () => httpClient.request(...))，
 *   断言后端真实收到的请求头包含 client-request-*，证明透传在真实网络链路上生效。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { AddressInfo } from 'node:net';

// 用 hoisted 变量在运行期注入 mock 后端地址（vi.mock 工厂会被提升到文件顶部）
const holder = vi.hoisted(() => ({ base: '' }));

vi.mock('../../src/config/env', () => ({
  getEnvConfig: () => ({
    env: 'test',
    openApiBase: holder.base,
    webBase: 'http://localhost',
    loginApiBase: 'http://localhost',
    platform: 1,
    language: 'en',
    currency: 'USD',
    tokenEncryptKey: 'test-key',
  }),
}));

// rate-limiter 不 mock 也可（真实令牌桶足够快），但为稳定性直接放行
vi.mock('../../src/api-client/rate-limiter', () => ({
  rateLimiter: {
    acquire: vi.fn().mockResolvedValue(undefined),
    getRetryDelay: vi.fn((n: number) => 10 * (n + 1)),
    getMaxRetries: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), rateLimit: vi.fn(), request: vi.fn() },
  isDebugMode: vi.fn(() => false),
}));

import { HttpClient, setTokenGetter } from '../../src/api-client/http-client';
import {
  clientRequestStorage,
  extractClientRequestContext,
} from '../../src/utils/client-request-context';

describe('client-request 透传（over-the-wire 集成）', () => {
  let server: Server;
  let received: IncomingHttpHeaders = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, result: true, message: 'ok', data: {} }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    holder.base = `http://127.0.0.1:${port}`;
    setTokenGetter(() => 'tok-abc');
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('入站 x-real-ip / host / user-agent 真实透传到后端请求头', async () => {
    const inboundHeaders: IncomingHttpHeaders = {
      'x-real-ip': '66.249.66.1',
      'x-forwarded-for': '66.249.66.1, 172.20.129.142',
      host: 'www.cjdropshipping.com',
      'x-original-url': '/mcp/API@CJ1@CJ:t',
      'user-agent': 'Googlebot',
    };
    const ctx = extractClientRequestContext(inboundHeaders);

    const client = new HttpClient();
    await clientRequestStorage.run(ctx, () => client.request('/product/query', { body: { keyword: 'x' } }));

    // 后端真实收到的 header（断言失败即真实链路未透传，后端仍拿 Pod IP）
    expect(received['client-request-ip']).toBe('66.249.66.1');
    expect(received['client-request-host']).toBe('www.cjdropshipping.com');
    // 安全：直连 Token 凭证段脱敏后透传（CWE-532），后端拿到 userId 但不含 access token
    expect(received['client-request-url']).toBe('/mcp/API@CJ1@CJ:***');
    expect(received['client-request-user-agent']).toBe('Googlebot');
    expect(received['x-forwarded-for']).toBe('66.249.66.1, 172.20.129.142');
    expect(received['cj-access-token']).toBe('tok-abc');
  });
});
