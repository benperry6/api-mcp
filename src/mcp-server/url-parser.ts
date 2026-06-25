/**
 * @fileoverview MCP HTTP 路径解析工具
 * 支持两种直接 Token URL 格式，均不需要服务端存储认证状态（stateless）：
 * - /mcp/API@{userId}@CJ:{accessToken}
 * - /mcp/MCP@{userId}@CJ:{accessToken}
 *
 * @note 纠正(MCP@ 支持): 原正则只支持 API@ 前缀（index.ts line 149），
 *   导致 ChatGPT 通过 MCP@ 格式传入的 token 被误识别为 CJ API Key 并尝试认证，
 *   产生 1600005 "APIkey is wrong" 错误。现提取为独立模块方便测试。
 */

/** 直接 Token URL 解析结果 */
export interface DirectTokenUrl {
  /** 用户标识（从 URL API@/MCP@{userId} 部分提取，如 CJ4623764） */
  userId: string;
  /** 直接从 URL 提取的 accessToken，用于 API 调用 */
  accessToken: string;
}

/**
 * 从 MCP URL 路径解析直接 Token 格式。
 *
 * 支持：
 * - /mcp/API@{userId}@CJ:{accessToken}  （原有格式）
 * - /mcp/MCP@{userId}@CJ:{accessToken}  （新增格式）
 *
 * @param urlPath - URL 路径（不含 query string），如 /mcp/API@CJ123@CJ:token123
 * @returns 解析结果，若不匹配则返回 undefined
 */
export function parseDirectTokenUrl(urlPath: string): DirectTokenUrl | undefined {
  const match = urlPath.match(/^\/mcp\/((API|MCP)@([^@]+)@CJ:(.+))$/);
  if (!match) return undefined;
  return {
    userId: decodeURIComponent(match[3]),
    accessToken: decodeURIComponent(match[4]),
  };
}
