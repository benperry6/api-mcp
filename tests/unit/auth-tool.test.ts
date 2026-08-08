/**
 * @fileoverview Auth Tool 单元测试 (Mock 外部调用)
 *
 * @note 纠正(支持多种登录方式): 新增 handleVerifyCredentials webLogin 响应处理测试组，
 * 覆盖以下场景：
 * 1. data.apiKey 存在 → getAccessToken 流程
 * 2. data.expireTime 用于实际过期时间
 * 3. data.extra.email 优先提取邮箱
 * 4. data.id 提取 openId
 * 5. 无 apiKey + 有 cjLoginToken → 直接存储
 * @note 纠正(支持多种登录方式-补充): 新增 accessToken 主字段和 csrfToken 可选场景：
 * 6. data.accessToken 作为主 token（优先级高于 cjLoginToken/token）
 * 7. csrfToken GET 失败时登录仍能继续（/foreign/webLogin 不需要 csrfToken）
 * 6. code:803 返回明确错误（mcpLogin 未开通）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAuthTool, getAuthTools } from '../../src/mcp-server/tools/auth.tool';
import { getResourcesList } from '../../src/mcp-server/resources';

// Mock session module
vi.mock('../../src/auth/session', () => ({
  getSession: vi.fn().mockReturnValue(null),
  isSessionValid: vi.fn().mockReturnValue(false),
  createSession: vi.fn(),
  clearSession: vi.fn(),
  ensureAccessToken: vi.fn().mockResolvedValue(null),
}));

/**
 * Mock 直连 Token 上下文（/mcp/API@userId@CJ:token）。
 * 默认 undefined = 普通本地/密码登录模式，不影响既有用例；
 * 直连 Token 相关用例自行 mockReturnValue 打开。
 */
const directTokenMock = vi.hoisted(() => ({
  directTokenStorage: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  getDirectTokenContext: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../src/auth/api-key-context', () => directTokenMock);

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
    tokenEncryptKey: '',
  }),
}));

// Mock rate limiter
vi.mock('../../src/api-client/rate-limiter', () => ({
  rateLimiter: {
    getStatus: () => ({
      tiers: {
        read: { available: 10, max: 10, refillRate: 10 },
        write: { available: 2, max: 2, refillRate: 2 },
        auth: { available: 1, max: 1, refillRate: 1 },
      },
      global: { available: 20, max: 20, refillRate: 20 },
      dailyQuota: { used: 5, max: 10000, remaining: 9995 },
      concurrency: { active: 1, max: 5, queued: 0 },
      cache: { size: 3, ttlMs: 300000 },
    }),
  },
}));

describe('auth.tool', () => {
  it('show_login_form 返回成功提示', async () => {
    const result = await handleAuthTool('show_login_form', {});
    expect(result.content[0].text).toContain('Login form displayed');
  });

  it('verify_credentials 仅传 apiKey 时被拒绝并提示已下线（E2）', async () => {
    const result = await handleAuthTool('verify_credentials', { apiKey: 'some_api_key' });
    expect(result.isError).toBe(true);
    // 仍指出正确做法（loginName/password）
    expect(result.content[0].text).toMatch(/loginName|password|邮箱|密码/);
    // 并明确告知 apiKey 登录已下线（与 URL reject 文案一致，避免"以为漏填参数"）
    expect(result.content[0].text).toMatch(/下线|removed/i);
  });

  it('check_login_status 未登录时提示登录', async () => {
    const result = await handleAuthTool('check_login_status', {});
    expect(result.content[0].text).toContain('未登录');
    expect(result.content[0].text).toContain('Not logged in');
  });

  it('get_rate_limit_status 返回限速状态', async () => {
    const result = await handleAuthTool('get_rate_limit_status', {});
    expect(result.content[0].text).toContain('10/10');
    expect(result.content[0].text).toContain('2/2');
    expect(result.content[0].text).toContain('1/1');
    expect(result.content[0].text).toContain('20/20');
  });

  it('verify_credentials 缺少参数返回错误', async () => {
    const result = await handleAuthTool('verify_credentials', {});
    expect(result.isError).toBe(true);
    // @note 纠正: 支持 loginName 后错误提示改为 email/loginName+password
    expect(result.content[0].text).toContain('email/loginName+password');
  });

  it('logout 清除会话并返回成功', async () => {
    const result = await handleAuthTool('logout', {});
    expect(result.content[0].text).toContain('已登出');
    expect(result.content[0].text).toContain('Logged out');
  });

  it('wait_for_login 未登录时超时返回引导消息（非错误）', async () => {
    // 未登录状态（isSessionValid mock 返回 false），设 1 秒超时
    // @note 纠正(41次): 超时不再标记 isError=true，而是返回引导消息，让 AI 询问用户是否已登录
    const result = await handleAuthTool('wait_for_login', { timeout: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('超时');
    expect(result.content[0].text).toContain('check_login_status');
  });

  it('wait_for_login 已登录时立即返回成功', async () => {
    // Mock isSessionValid 返回 true，getSession 返回用户信息
    const sessionModule = await import('../../src/auth/session');
    vi.mocked(sessionModule.isSessionValid).mockReturnValueOnce(true);
    vi.mocked(sessionModule.getSession).mockReturnValueOnce({ loginName: 'test@test.com' } as ReturnType<typeof sessionModule.getSession>);

    const result = await handleAuthTool('wait_for_login', { timeout: 10 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('已登录');
    /**
     * @note 已登录时不得返回登录 UI meta。
     * 业务影响：否则 Cursor / VS Code Copilet 会对已登录用户再弹一次登录表单
     *（源码注释记录过「即使已登录也会弹出」这个真实缺陷）。
     */
    expect(result._meta?.ui).toBeUndefined();
  });

  it('wait_for_login 在 CJ_UI_IMMEDIATE=true 时立即返回登录 UI meta', async () => {
    vi.stubEnv('CJ_UI_IMMEDIATE', 'true');
    const result = await handleAuthTool('wait_for_login', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('登录界面');
    /**
     * @note 必须是固定裸 URI，不能带 ?t= 时间戳。
     * 业务影响：带查询参数的 URI 在 resources/list 里没有对应条目，
     * 客户端查不到该资源就不会渲染登录 UI —— 这正是「登录 UI 一直不展示，
     * 而商品/订单 UI 正常」的根因（product/order 已在第4/5次提交改用固定 URI）。
     */
    expect((result._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe('ui://cj-mcp/login');
    vi.unstubAllEnvs();
  });

  /**
   * @note 根因回归：登录 UI 一直不展示，而商品/订单 UI 正常。
   * 差异只有一处——登录工具的 resourceUri 带 `?t=<时间戳>_<序号>`，
   * 而 resources/list 只广播裸 `ui://cj-mcp/login`，客户端在已知资源里
   * 查不到完全匹配项就不渲染。服务端 handleResourceRead 用 startsWith
   * 前缀匹配「读得到」，掩盖了「渲染不了」。
   * 业务影响：断言失败 = 用户在任何 MCP Apps 客户端都看不到登录界面。
   */
  it('登录工具注入的 resourceUri 必须能在 resources/list 中找到完全匹配项', () => {
    const advertised = new Set(getResourcesList().map(r => r.uri));
    // 前置确认：登录资源确实以裸 URI 广播
    expect(advertised.has('ui://cj-mcp/login')).toBe(true);

    const tools = getAuthTools();
    const loginUiTools = tools.filter(
      t => (t as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui?.resourceUri
    );
    // 未登录时，show_login_form 与 wait_for_login 都应带登录 UI
    expect(loginUiTools.map(t => t.name).sort()).toEqual(['show_login_form', 'wait_for_login']);

    for (const tool of loginUiTools) {
      const uri = (tool as { _meta?: { ui?: { resourceUri?: string } } })._meta!.ui!.resourceUri!;
      expect(uri).toBe('ui://cj-mcp/login');
      expect(advertised.has(uri)).toBe(true);
    }
  });

  /**
   * @note 已登录时不得注入任何登录 UI，避免对已登录用户弹登录表单。
   */
  it('getAuthTools 在已登录时不为任何工具注入登录 UI', async () => {
    const sessionModule = await import('../../src/auth/session');
    vi.mocked(sessionModule.isSessionValid).mockReturnValueOnce(true);

    const withUi = getAuthTools().filter(
      t => (t as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui?.resourceUri
    );
    expect(withUi).toEqual([]);
  });
});

/**
 * @note 纠正(支持多种登录方式): verify_credentials webLogin 响应字段处理测试
 * 覆盖 login.html UI → verify_credentials → webLogin → session 完整链路的响应处理
 * 关键场景：expireTime 实际值使用、extra.email 提取、openId 从 id 提取、
 *           apiKey 流程与 cjLoginToken 直存流程、code:803 错误处理
 */
describe('verify_credentials - webLogin 响应字段处理', () => {
  const sessionModule = vi.hoisted(() => ({
    getSession: vi.fn().mockReturnValue(null),
    isSessionValid: vi.fn().mockReturnValue(false),
    createSession: vi.fn(),
    clearSession: vi.fn(),
    ensureAccessToken: vi.fn().mockResolvedValue(null),
    setSessionDirect: vi.fn().mockImplementation((data: Record<string, unknown>) => data),
  }));

  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.mock('../../src/auth/session', () => sessionModule);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    sessionModule.createSession.mockReset();
    sessionModule.setSessionDirect.mockReset();
    sessionModule.setSessionDirect.mockImplementation((data: Record<string, unknown>) => data);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * @note 验证 data.apiKey 存在时走 getAccessToken 流程
   * 业务影响：apiKey 流程能获取 OpenAPI accessToken，后续 product/listV2 等接口可正常调用
   */
  it('webLogin 返回 apiKey 时调用 createSession 换取 OpenAPI accessToken', async () => {
    // Mock csrfToken 请求
    fetchMock.mockResolvedValueOnce({
      headers: {
        getSetCookie: () => ['csrfToken=test_csrf; Path=/'],
        get: () => 'text/html',
      },
      status: 200,
      text: async () => '',
    });
    // Mock webLogin 成功响应（含 apiKey）
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 200,
        success: true,
        message: 'success',
        data: {
          apiKey: 'test_api_key_123',
          token: 'USR@CJxxx@L5@CJ:frontend_token',
          cjLoginToken: 'USR@CJxxx@L5@CJ:frontend_token',
          id: 241958,
          num: 4001234,
          expireTime: Date.now() + 7 * 24 * 3600 * 1000,
          extra: { email: 'test@example.com' },
        },
      }),
    });

    sessionModule.createSession.mockResolvedValueOnce({
      email: 'test@example.com',
      accessToken: 'openapi_access_token',
      accessTokenExpiry: new Date(Date.now() + 86400_000).toISOString(),
      refreshToken: 'refresh_token',
      refreshTokenExpiry: new Date(Date.now() + 7 * 86400_000).toISOString(),
      openId: '241958',
    });

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'test@example.com',
      password: 'plain_password',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('登录成功');
    // 验证 createSession 被调用，表示走了 getAccessToken 流程
    expect(sessionModule.createSession).toHaveBeenCalledWith(
      expect.any(String),
      'test_api_key_123',
      expect.any(String)
    );
  });

  /**
   * @note 验证无 apiKey 但有 cjLoginToken 时直接存储 session
   * 业务影响：部分账号 webLogin 不返回 apiKey，需直接用 loginToken 调用后续接口
   */
  it('webLogin 无 apiKey 但有 cjLoginToken 时调用 setSessionDirect 存储', async () => {
    fetchMock.mockResolvedValueOnce({
      headers: { getSetCookie: () => ['csrfToken=csrf123; Path=/'], get: () => 'text/html' },
      status: 200,
      text: async () => '',
    });
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 200,
        success: true,
        message: 'success',
        data: {
          token: 'USR@CJfoo@L5@CJ:token_value',
          cjLoginToken: 'USR@CJfoo@L5@CJ:token_value',
          id: 99999,
          num: 5005005,
          expireTime: Date.now() + 14 * 24 * 3600 * 1000,
          extra: { email: 'user@cj.com' },
        },
      }),
    });

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'user@cj.com',
      password: 'any_password',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅');
    // 验证 setSessionDirect 被调用（不走 getAccessToken 流程）
    expect(sessionModule.setSessionDirect).toHaveBeenCalled();
    const callArg = sessionModule.setSessionDirect.mock.calls[0][0];
    expect(callArg.accessToken).toBe('USR@CJfoo@L5@CJ:token_value');
    expect(callArg.openId).toBe('99999');
  });

  /**
   * @note 验证 expireTime 被转换为 ISO 字符串存储
   * 业务影响：isAccessTokenExpired() 能正确判断有效期，避免过早失效或使用过期 token
   */
  it('webLogin 返回 expireTime 时 session 的 accessTokenExpiry 使用实际值', async () => {
    const futureTime = Date.now() + 10 * 24 * 3600 * 1000; // 10天后
    fetchMock.mockResolvedValueOnce({
      headers: { getSetCookie: () => ['csrfToken=csrf456; Path=/'], get: () => 'text/html' },
      status: 200,
      text: async () => '',
    });
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 200,
        success: true,
        message: 'success',
        data: {
          cjLoginToken: 'USR@CJbar@L5@CJ:token_expiry',
          id: 12345,
          expireTime: futureTime,
          extra: { email: 'expiry@test.com' },
        },
      }),
    });

    await handleAuthTool('verify_credentials', {
      loginName: 'expiry@test.com',
      password: 'test_pw',
    });

    expect(sessionModule.setSessionDirect).toHaveBeenCalled();
    const callArg = sessionModule.setSessionDirect.mock.calls[0][0];
    // 验证 accessTokenExpiry 使用实际 expireTime，而非硬编码14天
    const storedExpiry = new Date(callArg.accessTokenExpiry).getTime();
    // 允许 ±5 秒误差
    expect(Math.abs(storedExpiry - futureTime)).toBeLessThan(5000);
  });

  /**
   * @note 验证 extra.email 优先被提取为 email
   * 业务影响：check_login_status 显示正确的用户邮箱
   */
  it('webLogin 返回 extra.email 时 session 使用 extra.email 作为 email 字段', async () => {
    fetchMock.mockResolvedValueOnce({
      headers: { getSetCookie: () => ['csrfToken=csrf789; Path=/'], get: () => 'text/html' },
      status: 200,
      text: async () => '',
    });
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 200,
        success: true,
        message: 'success',
        data: {
          cjLoginToken: 'USR@CJbaz@L5@CJ:token_email',
          id: 77777,
          extra: { email: 'from_extra@cj.com' },
          email: 'wrong_email@cj.com', // 应优先使用 extra.email
        },
      }),
    });

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'from_extra@cj.com',
      password: 'pw',
    });

    expect(result.isError).toBeFalsy();
    expect(sessionModule.setSessionDirect).toHaveBeenCalled();
    const callArg = sessionModule.setSessionDirect.mock.calls[0][0];
    expect(callArg.email).toBe('from_extra@cj.com');
  });

  /**
   * @note 验证 code:803 时返回明确错误，且不触发 wait_for_login 打开新窗口
   * 业务影响：code:803 是 mcpLogin 未开通的错误，需清晰告知用户原因
   */
  it('webLogin 返回 code:803 时返回 isError=true 且包含明确错误信息', async () => {
    fetchMock.mockResolvedValueOnce({
      headers: { getSetCookie: () => ['csrfToken=csrfabc; Path=/'], get: () => 'text/html' },
      status: 200,
      text: async () => '',
    });
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 803,
        success: false,
        message: 'MCP login not authorized',
        data: null,
      }),
    });

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'blocked@cj.com',
      password: 'pw',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('803');
    // 不应触发新的登录窗口
    expect(result.content[0].text).toContain('verify_credentials');
  });

  /**
   * @note 纠正(支持多种登录方式-补充): 验证 data.accessToken 作为主 token 字段
   * 业务影响：实际生产 webLogin 响应返回的是 accessToken（完整 JWT），不是 cjLoginToken
   * 参考用户实际响应: data.accessToken = "USR@CJ100000@L0@CJ:eyJ..."
   */
  it('webLogin 返回 accessToken 字段时优先使用 accessToken 存储到 session', async () => {
    // Mock csrfToken 请求（正常返回 cookie）
    fetchMock.mockResolvedValueOnce({
      headers: { getSetCookie: () => ['csrfToken=csrf_ok; Path=/'], get: () => 'text/html' },
      status: 200,
      text: async () => '',
    });
    // Mock webLogin 响应：有 accessToken，无 cjLoginToken
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 200,
        success: true,
        message: 'success',
        data: {
          accessToken: 'USR@CJ100000@L0@CJ:eyJhbGciOiJIUzI1NiJ9.real_jwt_token',
          token: 'USR@CJ100000@L0@CJ:short_token',
          // 无 cjLoginToken 字段
          id: 'a0ab5c31ec2d4ea4981ddd8a0d2f994c',
          num: 'CJ100000',
          expireTime: '1780033156457',
          extra: { email: 'real@example.com' },
        },
      }),
    });

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'real@example.com',
      password: 'any',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅');
    expect(sessionModule.setSessionDirect).toHaveBeenCalled();
    const callArg = sessionModule.setSessionDirect.mock.calls[0][0];
    // accessToken 优先级最高，应存储完整 JWT
    expect(callArg.accessToken).toBe('USR@CJ100000@L0@CJ:eyJhbGciOiJIUzI1NiJ9.real_jwt_token');
  });

  /**
   * @note 纠正(支持多种登录方式-补充): 验证 csrfToken 获取失败时登录仍能继续
   * 业务影响：/userCenterForeignWeb/foreign/webLogin 是 foreign API，无需 csrfToken
   * 本地 macOS 开发时 GET /login.html 可能无 csrfToken cookie，不应阻塞登录
   */
  it('csrfToken GET 失败时登录仍能继续（/foreign/webLogin 不需要 csrfToken）', async () => {
    // Mock csrfToken 请求：返回 200 但无 Set-Cookie（正常浏览器场景以外无法获取）
    fetchMock.mockResolvedValueOnce({
      headers: {
        getSetCookie: () => [], // 无 csrfToken cookie
        get: () => 'text/html',
      },
      status: 200,
      text: async () => '',
    });
    // Mock webLogin 响应：正常登录成功
    fetchMock.mockResolvedValueOnce({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({
        code: 200,
        success: true,
        message: 'success',
        data: {
          accessToken: 'USR@CJ999@L0@CJ:no_csrf_jwt_token',
          id: 'user-uuid-no-csrf',
          num: 'CJ999999',
          expireTime: String(Date.now() + 7 * 24 * 3600 * 1000),
          extra: { email: 'nocsrf@example.com' },
        },
      }),
    });

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'nocsrf@example.com',
      password: 'pw',
    });

    // 关键验证：即使无 csrfToken，登录也应成功，不应抛出"无法获取 csrfToken"错误
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅');
    expect(sessionModule.setSessionDirect).toHaveBeenCalled();
    const callArg = sessionModule.setSessionDirect.mock.calls[0][0];
    expect(callArg.accessToken).toBe('USR@CJ999@L0@CJ:no_csrf_jwt_token');
  });
});

/**
 * @note 直连 Token 模式（URL = /mcp/API@{userId}@CJ:{token}）下的换号语义。
 *
 * 该模式的认证态来自每请求的 AsyncLocalStorage，服务端无任何可清除的存储，
 * 因此「换号」只能靠用户改 URL。此前 logout 与 verify_credentials 都会
 * 假报成功，误导 AI 与用户以为已经换号/登出：
 * - logout 只清进程内 currentSession + token 文件，却打印「✅ 已登出」
 * - verify_credentials 真登录、真写 currentSession、真报成功，但之后
 *   getSession() 仍优先返回 URL token 的合成 session，结果永远读不到
 */
describe('直连 Token 模式下的换号语义', () => {
  beforeEach(() => {
    directTokenMock.getDirectTokenContext.mockReturnValue({
      userId: 'CJ620569',
      accessToken: 'url_direct_token',
    });
  });

  afterEach(() => {
    directTokenMock.getDirectTokenContext.mockReturnValue(undefined);
    vi.unstubAllGlobals();
  });

  /**
   * 业务影响：断言失败 = 用户以为已登出并让 AI 继续换号，
   * 实际下一个请求仍用 URL 里的 token 以原账号执行操作。
   */
  it('logout 不谎报成功，明确告知需更换 URL 才能换号', async () => {
    const result = await handleAuthTool('logout', {});
    expect(result.content[0].text).not.toContain('已登出');
    expect(result.content[0].text).toMatch(/URL/);
    expect(result.content[0].text).toContain('CJ620569');
  });

  /**
   * 业务影响：断言失败 = verify_credentials 静默空转，
   * AI 收到「登录成功」却仍以旧账号调用业务接口。
   */
  it('verify_credentials 直接拒绝并说明原因，不发起登录请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleAuthTool('verify_credentials', {
      loginName: 'other@cj.com',
      password: 'pw',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/URL/);
    // 不得真的去登录（否则会写入一个永远读不到的 session）
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
