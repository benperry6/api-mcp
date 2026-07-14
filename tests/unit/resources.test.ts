import { describe, expect, it, vi } from 'vitest';
import {
  CJ_MCP_UI_CSP,
  MCP_APP_HTML_MIME,
  cleanupExpiredUiCache,
  getProductListCache,
  getResourcesList,
  handleResourceRead,
  resolveMaxUsers,
  setOrderListCache,
  setProductDetailCache,
  setProductListCache,
} from '../../src/mcp-server/resources/index.js';
import { httpClient } from '../../src/api-client/http-client.js';
import { directTokenStorage } from '../../src/auth/api-key-context.js';

describe('MCP UI resources', () => {
  it('resources/list 使用 MCP Apps 标准 mimeType', () => {
    const resources = getResourcesList();
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource.mimeType).toBe(MCP_APP_HTML_MIME);
    }
  });

  it('resources/read 返回 MCP Apps 标准 mimeType', async () => {
    const uri = 'ui://cj-mcp/login?t=123';
    const result = await handleResourceRead(uri);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe(MCP_APP_HTML_MIME);
    expect(result.contents[0].text).toContain('<!DOCTYPE html>');
  });

  it('resources/list 与 resources/read 声明 CJ CDN CSP（Cursor/Codex 远程图片）', async () => {
    const listed = getResourcesList();
    expect(listed[0]._meta?.ui?.csp?.resourceDomains).toContain(
      'https://cf.cjdropshipping.com',
    );

    const result = await handleResourceRead('ui://cj-mcp/product-list?t=1');
    const domains = result.contents[0]._meta?.ui?.csp?.resourceDomains;
    expect(domains).toEqual(CJ_MCP_UI_CSP.resourceDomains);
    expect(domains).toContain('https://*.cjdropshipping.com');
  });

  it('读 product-list 模板不触发后端 API（已认证且缓存为空时也不再拉数据）', async () => {
    setProductListCache(null); // 冷缓存
    const spy = vi.spyOn(httpClient, 'request').mockResolvedValue({
      code: 200,
      result: true,
      message: 'ok',
      data: { content: [] },
    } as never);

    // directToken 上下文 → getAccessToken() 返回有效 token，旧逻辑会尝试拉数据
    await directTokenStorage.run(
      { userId: 'CJ_TEST', accessToken: 'tok_test' },
      async () => {
        const result = await handleResourceRead('ui://cj-mcp/product-list');
        expect(result.contents[0].mimeType).toBe(MCP_APP_HTML_MIME);
        expect(result.contents[0].text).toContain('<!DOCTYPE html>');
      },
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('读 order-list 模板不触发后端 fetch（已认证且缓存为空时也不再拉数据）', async () => {
    setOrderListCache(null); // 冷缓存
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 }),
    );

    await directTokenStorage.run(
      { userId: 'CJ_TEST', accessToken: 'tok_test' },
      async () => {
        const result = await handleResourceRead('ui://cj-mcp/order-list');
        expect(result.contents[0].mimeType).toBe(MCP_APP_HTML_MIME);
        expect(result.contents[0].text).toContain('<!DOCTYPE html>');
      },
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('UI 缓存按用户隔离：A 写入的数据不会被 B 读到', async () => {
    const dataA = { content: [{ productList: [{ id: 'USER-A-1' }] }] };

    // 用户 A 写入
    await directTokenStorage.run(
      { userId: 'CJ_ISO_A', accessToken: 'tokA' },
      async () => {
        setProductListCache(dataA);
        expect(getProductListCache()).toEqual(dataA); // A 读到自己的
      },
    );

    // 用户 B 读取 —— 必须读不到 A 的数据
    await directTokenStorage.run(
      { userId: 'CJ_ISO_B', accessToken: 'tokB' },
      async () => {
        expect(getProductListCache()).toBeNull();
      },
    );

    // 用户 A 再次读取 —— 仍能读到自己的（功能保留）
    await directTokenStorage.run(
      { userId: 'CJ_ISO_A', accessToken: 'tokA' },
      async () => {
        expect(getProductListCache()).toEqual(dataA);
      },
    );
  });

  it('resources/read 注入的 __INITIAL_DATA__ 也按用户隔离', async () => {
    const dataA = { content: [{ productList: [{ id: 'INJECT-A-1' }] }] };
    await directTokenStorage.run(
      { userId: 'CJ_INJ_A', accessToken: 'tokA' },
      async () => {
        setProductListCache(dataA);
      },
    );

    // 用户 B 读模板：不应含 A 的数据，也不应有注入的赋值脚本
    await directTokenStorage.run(
      { userId: 'CJ_INJ_B', accessToken: 'tokB' },
      async () => {
        const result = await handleResourceRead('ui://cj-mcp/product-list');
        expect(result.contents[0].text).not.toContain('INJECT-A-1');
        // 注入脚本形如 `window.__INITIAL_DATA__ = {...}`；模板自身只“读取”不“赋值”
        expect(result.contents[0].text).not.toContain('window.__INITIAL_DATA__ = {');
      },
    );

    // 用户 A 读模板：应含自己的数据（注入了赋值脚本）
    await directTokenStorage.run(
      { userId: 'CJ_INJ_A', accessToken: 'tokA' },
      async () => {
        const result = await handleResourceRead('ui://cj-mcp/product-list');
        expect(result.contents[0].text).toContain('INJECT-A-1');
        expect(result.contents[0].text).toContain('window.__INITIAL_DATA__ = {');
      },
    );
  });

  it('#2 滑动 TTL：持续读取会刷新过期，缓存不被清理', () => {
    vi.useFakeTimers();
    try {
      const ctx = { userId: 'CJ_TTL_READ', accessToken: 't' };
      directTokenStorage.run(ctx, () => setProductListCache({ v: 1 }));

      // 前进 25 分钟后读取一次（真正的滑动 TTL 应据此刷新过期时间）
      vi.advanceTimersByTime(25 * 60 * 1000);
      directTokenStorage.run(ctx, () => {
        expect(getProductListCache()).toEqual({ v: 1 });
      });

      // 再前进 25 分钟：距上次「写入」已 50 分钟，但距上次「读取」仅 25 分钟
      vi.advanceTimersByTime(25 * 60 * 1000);
      cleanupExpiredUiCache();

      // 若为真正的滑动 TTL（读也刷新 expiry），缓存应仍在
      directTokenStorage.run(ctx, () => {
        expect(getProductListCache()).toEqual({ v: 1 });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('#1 XSS：注入的缓存数据被转义，</script> 不会逃逸出内联脚本', async () => {
    const evil = {
      content: [
        { productList: [{ nameEn: '</script><img src=x onerror=alert(1)>' }] },
      ],
    };
    await directTokenStorage.run(
      { userId: 'CJ_XSS', accessToken: 't' },
      async () => {
        setProductListCache(evil);
        const result = await handleResourceRead('ui://cj-mcp/product-list');
        const text = result.contents[0].text;
        // 注入脚本存在
        expect(text).toContain('window.__INITIAL_DATA__ = {');
        // 原始恶意串（含裸 </script>）不得出现在输出中
        expect(text).not.toContain('</script><img src=x onerror=alert(1)>');
        // '<' 必须被转义为 <
        expect(text).toContain('\\u003c/script\\u003e');
      },
    );
  });

  it('#3 缓存键绑定 accessToken 而非 URL userId：同 userId 不同 token 不共享', async () => {
    const victimData = { secret: 'VICTIM-DATA' };
    // 受害者：userId=V，token=victim_tok
    await directTokenStorage.run(
      { userId: 'V', accessToken: 'victim_tok' },
      async () => {
        setProductListCache(victimData);
      },
    );
    // 攻击者：伪造相同 userId=V，但用自己的 token —— 不应读到受害者数据
    await directTokenStorage.run(
      { userId: 'V', accessToken: 'attacker_tok' },
      async () => {
        expect(getProductListCache()).toBeNull();
      },
    );
    // 受害者用自己的 token 仍能读到自己的数据
    await directTokenStorage.run(
      { userId: 'V', accessToken: 'victim_tok' },
      async () => {
        expect(getProductListCache()).toEqual(victimData);
      },
    );
  });

  it('#5 resolveMaxUsers：非正/非法值回退默认，正整数生效', () => {
    expect(resolveMaxUsers(undefined)).toBe(500);
    expect(resolveMaxUsers('0')).toBe(500);
    expect(resolveMaxUsers('-1')).toBe(500);
    expect(resolveMaxUsers('abc')).toBe(500);
    expect(resolveMaxUsers('1.5')).toBe(500);
    expect(resolveMaxUsers('200')).toBe(200);
  });

  it('#1 $ 替换污染：注入数据中的 $ 序列不被 String.replace 特殊解释', async () => {
    // $' 会插入匹配后子串、$& 插入匹配串 —— 若用字符串式 replace 会污染注入数据
    const data = { content: [{ productList: [{ nameEn: "MARK$'MARK$&END" }] }] };
    await directTokenStorage.run(
      { userId: 'CJ_DOLLAR', accessToken: 't' },
      async () => {
        setProductListCache(data);
        const result = await handleResourceRead('ui://cj-mcp/product-list');
        // 字面量应原样保留（函数式 replace 不解释 $ 模式）
        expect(result.contents[0].text).toContain("MARK$'MARK$&END");
      },
    );
  });

  it('#1 XSS：product-detail 注入点同样转义（守卫 detailData 分支）', async () => {
    const evil = { nameEn: '</script><svg onload=alert(1)>' };
    await directTokenStorage.run(
      { userId: 'CJ_XSS_D', accessToken: 't' },
      async () => {
        setProductDetailCache(evil);
        const result = await handleResourceRead('ui://cj-mcp/product-detail');
        const text = result.contents[0].text;
        expect(text).not.toContain('</script><svg onload=alert(1)>');
        expect(text).toContain('\\u003c/script\\u003e');
      },
    );
  });
});
