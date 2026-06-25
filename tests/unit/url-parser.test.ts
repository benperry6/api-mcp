/**
 * @fileoverview MCP URL 路径解析单元测试
 * 覆盖 parseDirectTokenUrl：
 *  1. API@ 格式（已有）正常解析
 *  2. MCP@ 格式（新增）正常解析
 *  3. 普通 apiKey 格式（不含 @CJ:）不匹配
 *  4. JWT token 误传时不被识别为直接 Token
 *  5. URL 编码的 accessToken 被正确解码
 */
import { describe, it, expect } from 'vitest';
import { parseDirectTokenUrl } from '../../src/mcp-server/url-parser';

describe('parseDirectTokenUrl — 直接 Token URL 解析', () => {
  it('API@ 格式被正确解析', () => {
    const result = parseDirectTokenUrl('/mcp/API@CJ4623764@CJ:myAccessToken123');
    expect(result).not.toBeUndefined();
    expect(result?.userId).toBe('CJ4623764');
    expect(result?.accessToken).toBe('myAccessToken123');
  });

  it('MCP@ 格式被正确解析（新增支持）', () => {
    const result = parseDirectTokenUrl('/mcp/MCP@CJ4623764@CJ:eyJhbGciOiJI');
    expect(result).not.toBeUndefined();
    expect(result?.userId).toBe('CJ4623764');
    expect(result?.accessToken).toBe('eyJhbGciOiJI');
  });

  it('普通 CJ API Key 格式不匹配（应走 apiKey 认证流程）', () => {
    expect(parseDirectTokenUrl('/mcp/CJ5298622@apikey')).toBeUndefined();
  });

  it('JWT token 直接放入路径不匹配（避免误当 CJ API Key）', () => {
    // 场景：ChatGPT 误将 JWT 直接放入 /mcp/{jwt} 而非 MCP@userId@CJ:jwt 格式
    expect(parseDirectTokenUrl('/mcp/eyJhbGciOiJI')).toBeUndefined();
  });

  it('accessToken 含 URL 编码字符时被正确解码', () => {
    const encoded = encodeURIComponent('token+with/special=chars');
    const result = parseDirectTokenUrl(`/mcp/API@CJ123@CJ:${encoded}`);
    expect(result?.accessToken).toBe('token+with/special=chars');
  });

  it('/mcp 路径（无 apiKey）不匹配', () => {
    expect(parseDirectTokenUrl('/mcp')).toBeUndefined();
  });

  it('/health 路径不匹配', () => {
    expect(parseDirectTokenUrl('/health')).toBeUndefined();
  });
});
