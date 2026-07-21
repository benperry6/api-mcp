/**
 * @fileoverview 客户端原始请求上下文（AsyncLocalStorage）
 *
 * @note 新增(第1次提交 / 26年07月19日): 修复「HTTP transport 下原始客户端 IP 丢失」问题。
 *   背景：MCP 以 HTTP/HTTPS transport 供 ChatGPT 等外部客户端调用时，服务端再向真实后端接口
 *   发起请求会「新建」一次 HTTP 调用（http-client / 各 raw fetch），仅携带 Content-Type +
 *   CJ-Access-Token，导致后端读到的是 MCP 云端 Pod 的出口 IP，而非用户原始 IP，
 *   风控/地域/日志全部失真。
 *
 *   方案（对齐既有 {@link file://../auth/api-key-context.ts} 的 directTokenStorage 模式）：
 *   1. HTTP 入口（mcp-server/index.ts）从 req.headers 提取用户原始请求信息，注入本 AsyncLocalStorage；
 *   2. 所有对外后端出口（api-client/http-client.ts + logistics/order/auth 三个 raw fetch）
 *      从上下文读取并透传为后端约定 header：
 *        - client-request-ip          ← x-real-ip；缺省取 x-forwarded-for 首个地址
 *        - client-request-host        ← host
 *        - client-request-url         ← x-original-url（ingress 转发的原始 url）
 *        - client-request-user-agent  ← user-agent
 *        - x-forwarded-for            ← 原链路透传；为空时用 x-real-ip 兜底放入首位
 *
 *   stdio 模式（Claude Desktop / Cursor 本地）无 HTTP 请求，上下文缺省为 undefined，
 *   透传自动跳过（优雅降级），不影响本地调用。
 *
 * @note 业务零篡改：全部为增量 header，后端存在即读取、不存在则忽略，不改变任何既有业务逻辑。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * 后端约定的透传 header key（与后端常量对齐）。
 * @see 后端: CLIENT_REQUEST_IP / CLIENT_REQUEST_URL / CLIENT_REQUEST_HOST
 */
export const CLIENT_REQUEST_IP = 'client-request-ip';
export const CLIENT_REQUEST_URL = 'client-request-url';
export const CLIENT_REQUEST_HOST = 'client-request-host';
export const CLIENT_REQUEST_USER_AGENT = 'client-request-user-agent';
export const X_FORWARDED_FOR = 'x-forwarded-for';

/** 客户端原始请求上下文（每个 HTTP 请求作用域一份） */
export interface ClientRequestContext {
  /** 外部请求 IP（client-request-ip）：x-real-ip 优先，否则 x-forwarded-for 首地址 */
  clientRequestIp?: string;
  /** 外部请求 url（client-request-url）：来自 x-original-url */
  clientRequestUrl?: string;
  /** 外部请求主机名（client-request-host）：来自 host */
  clientRequestHost?: string;
  /** 外部请求 UA（client-request-user-agent）：来自 user-agent */
  clientRequestUserAgent?: string;
  /** 转发链路（x-forwarded-for）：原链路透传，为空时用 x-real-ip 兜底 */
  xForwardedFor?: string;
}

/** 请求作用域上下文存储（与 directTokenStorage 一样按 AsyncLocalStorage 每请求隔离） */
export const clientRequestStorage = new AsyncLocalStorage<ClientRequestContext>();

/**
 * 获取当前异步上下文中的客户端原始请求上下文。
 * @returns 若当前不在 HTTP 请求上下文中（如 stdio 模式），返回 undefined。
 */
export function getClientRequestContext(): ClientRequestContext | undefined {
  return clientRequestStorage.getStore();
}

/**
 * 从 header 取单值：Node 对同名 header 可能给出数组，此处取第一个。
 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * @description 脱敏 URL 中的直连 Token 凭证段，避免 access token 落后端日志。
 *
 * @note 纠正(第1次提交对抗式评审 / 26年07月19日, 安全 CWE-532 secrets-in-logs):
 *   直连 Token 模式入站 URL 形如 `/mcp/API@{userId}@CJ:{accessToken}`（见 url-parser.ts），
 *   其 accessToken 是按设计长期有效的活凭证。ingress 的 `x-original-url` 天然内嵌该 token，
 *   若原样透传为 `client-request-url`（该字段合同用途即供后端风控/审计/日志「记录」），
 *   等于把活凭证写入后端持久日志——暴露面从「一次实时请求」扩大到「长期留存日志」。
 *   故在提取处剥离 `@CJ:` 之后的凭证段（保留 userId/路径供审计），再写入上下文。
 *
 * @param url 原始 URL（可能来自 x-original-url，含直连 Token）
 * @returns 脱敏后的 URL：`@CJ:{token}` → `@CJ:***`；不含凭证段的 URL 原样返回
 */
function sanitizeUrlCredentials(url: string | undefined): string | undefined {
  if (!url) return url;
  // 匹配 @CJ: 之后到下一个 / ? # 或空白（或结尾）为止的凭证串；token 在 URL 中已编码，不含 / ? #
  return url.replace(/(@CJ:)[^/?#\s]+/gi, '$1***');
}

/**
 * 从入站 HTTP 请求头提取客户端原始请求上下文。
 *
 * @param headers - Node `req.headers`（key 已由 Node 统一小写）
 * @returns 提取出的上下文；无对应 header 的字段为 undefined
 */
export function extractClientRequestContext(headers: IncomingHttpHeaders): ClientRequestContext {
  const xRealIp = firstHeader(headers['x-real-ip']);
  const xff = firstHeader(headers['x-forwarded-for']);

  // x-forwarded-for 首个地址（客户原始调用地址）
  const firstXffAddr = xff ? xff.split(',')[0].trim() : undefined;

  // client-request-ip：优先 x-real-ip，否则取 x-forwarded-for 首个地址
  const clientRequestIp = xRealIp || firstXffAddr;

  // x-forwarded-for：有则透传原链路；为空则用 x-real-ip 兜底放入首位
  const xForwardedFor = xff || xRealIp;

  return {
    clientRequestIp,
    // @note 纠正(安全 CWE-532): x-original-url 在直连 Token 模式含活凭证，脱敏后再透传
    clientRequestUrl: sanitizeUrlCredentials(firstHeader(headers['x-original-url'])),
    clientRequestHost: firstHeader(headers['host']),
    clientRequestUserAgent: firstHeader(headers['user-agent']),
    xForwardedFor,
  };
}

/**
 * 基于当前上下文构建需透传给后端的 header map。
 *
 * @returns 需合并到出站请求 headers 的键值对；无上下文或字段为空时对应 key 缺省。
 *   stdio 模式（无上下文）返回空对象，出站请求 header 不受影响。
 */
export function buildClientRequestHeaders(): Record<string, string> {
  const ctx = getClientRequestContext();
  if (!ctx) return {};

  const headers: Record<string, string> = {};
  if (ctx.clientRequestIp) headers[CLIENT_REQUEST_IP] = ctx.clientRequestIp;
  if (ctx.clientRequestUrl) headers[CLIENT_REQUEST_URL] = ctx.clientRequestUrl;
  if (ctx.clientRequestHost) headers[CLIENT_REQUEST_HOST] = ctx.clientRequestHost;
  if (ctx.clientRequestUserAgent) headers[CLIENT_REQUEST_USER_AGENT] = ctx.clientRequestUserAgent;
  if (ctx.xForwardedFor) headers[X_FORWARDED_FOR] = ctx.xForwardedFor;
  return headers;
}
