/**
 * @fileoverview 客户端原始请求上下文（AsyncLocalStorage）单元测试
 *
 * 背景（26年07月19日 第1次提交）：MCP 以 HTTP transport 供 ChatGPT 调用时，
 *   服务端向真实后端接口发起请求会「新建」HTTP 请求，只带 Content-Type + CJ-Access-Token，
 *   导致后端读到的是 MCP 云端 Pod 的 IP，而非用户原始 IP。本测试先行（TDD）覆盖：
 *   - extractClientRequestContext：从入站 header 正确映射客户端原始请求信息
 *   - buildClientRequestHeaders：按后端约定 key 构建出站透传 header
 */
import { describe, it, expect } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import {
  CLIENT_REQUEST_IP,
  CLIENT_REQUEST_URL,
  CLIENT_REQUEST_HOST,
  CLIENT_REQUEST_USER_AGENT,
  X_FORWARDED_FOR,
  clientRequestStorage,
  extractClientRequestContext,
  buildClientRequestHeaders,
  getClientRequestContext,
} from '../../src/utils/client-request-context';

describe('client-request-context', () => {
  describe('常量与后端约定对齐', () => {
    it('header key 与后端常量一致', () => {
      expect(CLIENT_REQUEST_IP).toBe('client-request-ip');
      expect(CLIENT_REQUEST_URL).toBe('client-request-url');
      expect(CLIENT_REQUEST_HOST).toBe('client-request-host');
      expect(CLIENT_REQUEST_USER_AGENT).toBe('client-request-user-agent');
      expect(X_FORWARDED_FOR).toBe('x-forwarded-for');
    });
  });

  describe('extractClientRequestContext', () => {
    it('完整 header 全部正确映射（URL 凭证段脱敏）', () => {
      const headers: IncomingHttpHeaders = {
        'x-real-ip': '66.249.66.1',
        'x-forwarded-for': '66.249.66.1, 172.20.129.142',
        host: 'www.cjdropshipping.com',
        'x-original-url': '/mcp/API@CJ123@CJ:tok',
        'user-agent': 'Googlebot',
      };
      const ctx = extractClientRequestContext(headers);
      expect(ctx.clientRequestIp).toBe('66.249.66.1');
      expect(ctx.clientRequestHost).toBe('www.cjdropshipping.com');
      // 安全：直连 Token 凭证段被脱敏，避免 access token 落后端日志（CWE-532）
      expect(ctx.clientRequestUrl).toBe('/mcp/API@CJ123@CJ:***');
      expect(ctx.clientRequestUserAgent).toBe('Googlebot');
      expect(ctx.xForwardedFor).toBe('66.249.66.1, 172.20.129.142');
    });

    it('x-original-url 直连 Token 凭证段脱敏（保留 userId 供审计）', () => {
      // 普通路径不含凭证 → 原样
      expect(extractClientRequestContext({ 'x-original-url': '/mcp' }).clientRequestUrl).toBe('/mcp');
      // API@ 直连 Token → token 段脱敏
      expect(extractClientRequestContext({ 'x-original-url': '/mcp/API@CJ4623764@CJ:abcDEF123' }).clientRequestUrl)
        .toBe('/mcp/API@CJ4623764@CJ:***');
      // MCP@ 直连 Token → token 段脱敏
      expect(extractClientRequestContext({ 'x-original-url': '/mcp/MCP@CJ1@CJ:xyz' }).clientRequestUrl)
        .toBe('/mcp/MCP@CJ1@CJ:***');
      // token 内含嵌套 @CJ:（如 USR@id@CJ:jwt）也被整体脱敏
      expect(extractClientRequestContext({ 'x-original-url': '/mcp/API@CJ1@CJ:USR@9@CJ:eyJhbGc' }).clientRequestUrl)
        .toBe('/mcp/API@CJ1@CJ:***');
      // 带 query string：仅凭证段脱敏，query 保留
      expect(extractClientRequestContext({ 'x-original-url': '/mcp/API@CJ1@CJ:tok?x=1' }).clientRequestUrl)
        .toBe('/mcp/API@CJ1@CJ:***?x=1');
    });

    it('client-request-ip 优先取 x-real-ip', () => {
      const ctx = extractClientRequestContext({
        'x-real-ip': '1.1.1.1',
        'x-forwarded-for': '2.2.2.2, 3.3.3.3',
      });
      // 断言失败会导致后端拿到错误的客户端 IP（风控/地域判断错误）
      expect(ctx.clientRequestIp).toBe('1.1.1.1');
    });

    it('无 x-real-ip 时 client-request-ip 取 x-forwarded-for 首个地址', () => {
      const ctx = extractClientRequestContext({
        'x-forwarded-for': '2.2.2.2, 3.3.3.3',
      });
      expect(ctx.clientRequestIp).toBe('2.2.2.2');
    });

    it('x-forwarded-for 为空时用 x-real-ip 兜底填入首位', () => {
      const ctx = extractClientRequestContext({ 'x-real-ip': '4.4.4.4' });
      // 后端约定：若 x_forward_for 为空，取 x-real-ip 值放入第一个
      expect(ctx.xForwardedFor).toBe('4.4.4.4');
      expect(ctx.clientRequestIp).toBe('4.4.4.4');
    });

    it('数组形式 header 取首值', () => {
      const ctx = extractClientRequestContext({
        'x-real-ip': ['5.5.5.5', '6.6.6.6'] as unknown as string[],
        host: ['a.com', 'b.com'] as unknown as string[],
      });
      expect(ctx.clientRequestIp).toBe('5.5.5.5');
      expect(ctx.clientRequestHost).toBe('a.com');
    });

    it('x-forwarded-for 首地址去除空白', () => {
      const ctx = extractClientRequestContext({
        'x-forwarded-for': '  7.7.7.7 , 8.8.8.8',
      });
      expect(ctx.clientRequestIp).toBe('7.7.7.7');
    });

    it('空 header 时字段均为 undefined', () => {
      const ctx = extractClientRequestContext({});
      expect(ctx.clientRequestIp).toBeUndefined();
      expect(ctx.clientRequestHost).toBeUndefined();
      expect(ctx.clientRequestUrl).toBeUndefined();
      expect(ctx.clientRequestUserAgent).toBeUndefined();
      expect(ctx.xForwardedFor).toBeUndefined();
    });
  });

  describe('buildClientRequestHeaders', () => {
    it('无上下文（stdio 模式）返回空对象', () => {
      // 未包裹在 clientRequestStorage.run 中，getStore() 为 undefined
      expect(getClientRequestContext()).toBeUndefined();
      expect(buildClientRequestHeaders()).toEqual({});
    });

    it('上下文内构建全部约定 header', () => {
      const ctx = {
        clientRequestIp: '66.249.66.1',
        clientRequestUrl: '/mcp',
        clientRequestHost: 'www.cjdropshipping.com',
        clientRequestUserAgent: 'Googlebot',
        xForwardedFor: '66.249.66.1, 172.20.129.142',
      };
      const headers = clientRequestStorage.run(ctx, () => buildClientRequestHeaders());
      expect(headers[CLIENT_REQUEST_IP]).toBe('66.249.66.1');
      expect(headers[CLIENT_REQUEST_URL]).toBe('/mcp');
      expect(headers[CLIENT_REQUEST_HOST]).toBe('www.cjdropshipping.com');
      expect(headers[CLIENT_REQUEST_USER_AGENT]).toBe('Googlebot');
      expect(headers[X_FORWARDED_FOR]).toBe('66.249.66.1, 172.20.129.142');
    });

    it('上下文部分字段缺失时跳过对应 header', () => {
      const ctx = { clientRequestIp: '9.9.9.9' };
      const headers = clientRequestStorage.run(ctx, () => buildClientRequestHeaders());
      expect(headers[CLIENT_REQUEST_IP]).toBe('9.9.9.9');
      expect(headers[CLIENT_REQUEST_HOST]).toBeUndefined();
      expect(headers[CLIENT_REQUEST_URL]).toBeUndefined();
      expect(Object.keys(headers)).toEqual([CLIENT_REQUEST_IP]);
    });

    it('端到端：extract 后在上下文内构建 header', () => {
      const ctx = extractClientRequestContext({
        'x-real-ip': '66.249.66.1',
        host: 'www.cjdropshipping.com',
        'user-agent': 'Googlebot',
      });
      const headers = clientRequestStorage.run(ctx, () => buildClientRequestHeaders());
      expect(headers[CLIENT_REQUEST_IP]).toBe('66.249.66.1');
      expect(headers[CLIENT_REQUEST_HOST]).toBe('www.cjdropshipping.com');
      expect(headers[CLIENT_REQUEST_USER_AGENT]).toBe('Googlebot');
      // x-real-ip 兜底进 x-forwarded-for
      expect(headers[X_FORWARDED_FOR]).toBe('66.249.66.1');
    });
  });
});
