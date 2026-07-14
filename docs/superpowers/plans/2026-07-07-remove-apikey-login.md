# 下线 apiKey 登录（E1 + E2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 移除两种「用 apiKey 换取 OpenAPI token 登录」的入口——E1（URL `/mcp/{apiKey}` 自动认证）与 E2（`verify_credentials` 的 `apiKey` 参数）；对裸 apiKey URL 返回显式错误。保留密码登录、E3（密码登录内部若拿到账号 apiKey 仍换 token，即 `createSession`）、以及直连 Token URL（`/mcp/API@…@CJ:…`）。

**Architecture:** E1 的自动认证机制（`ensureApiKeySession` + `apiKeyStorage` + `apiKeySessions` Map + 定时清理）整体删除；HTTP 路由改由新的纯函数 `classifyMcpPath()` 决策（`plain` / `directToken` / `reject`），裸 apiKey 路径归入 `reject` → HTTP 400。E2 从 `verify_credentials` 删除 apiKey 分支与入参。`createSession` 本身保留（E3 仍用）。`session.ts` 里所有「apiKey 上下文分支」删除，回落到本地会话 / 直连 Token。

**Tech Stack:** TypeScript (ESM, Node ≥20)、@modelcontextprotocol/sdk、vitest、esbuild。

---

## 文件结构（改动映射）

| 文件 | 责任 | 本次改动 |
|---|---|---|
| `src/mcp-server/url-parser.ts` | MCP URL 解析 | **新增** `classifyMcpPath()` 纯函数（决策 plain/directToken/reject） |
| `src/mcp-server/index.ts` | HTTP 入口与路由 | 删 `ensureApiKeySession`、`apiKeyStorage.run` 分支、`urlApiKey`；改用 `classifyMcpPath`；裸 apiKey → 400 |
| `src/mcp-server/tools/auth.tool.ts` | 登录/凭证工具 | 删 `verify_credentials` 的 `apiKey` 入参与 `if(apiKey)` 分支（E2）；删 `getContextApiKey` 分支与 `/mcp/{apiKey}` 文案 |
| `src/mcp-server/resources/index.ts` | UI Resources + 缓存 | `getUiCacheKey` 删 `ak:` 分支与 `getContextApiKey` 引用 |
| `src/auth/session.ts` | 会话管理 | 删 `apiKeySessions`/`cleanupExpiredApiKeySessions`/清理定时器/全部 `ctxApiKey` 分支；保留 `createSession` 等 |
| `src/auth/api-key-context.ts` | 请求上下文 | 删 `apiKeyStorage`、`getContextApiKey`；保留 `directTokenStorage`、`getDirectTokenContext` |
| `tests/unit/url-parser.test.ts` | 解析单测 | 新增 `classifyMcpPath` 用例；订正旧注释 |
| `tests/unit/api-key-url.test.ts` | 会话单测 | 删「apiKey URL 认证」describe 块；保留并清理「直接 Token 模式」describe（去掉 `apiKeyStorage`） |
| `tests/unit/auth-tool.test.ts` | 工具单测 | 新增「verify_credentials 仅传 apiKey 被拒」用例；E3（webLogin 有/无 apiKey）用例保持 |

**任务顺序原则：** 先加纯函数与新行为测试（可编译、可绿）；先让引用了待删导出的测试脱钩，再删导出，保证每次提交都能编译、`yarn build` 通过。删除顺序：消费者（index/auth/resources）→ session.ts → api-key-context.ts。

---

## Task 1: 新增 `classifyMcpPath` 纯函数（可单测的路由决策）

**Files:**
- Modify: `src/mcp-server/url-parser.ts`
- Test: `tests/unit/url-parser.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `tests/unit/url-parser.test.ts` 末尾）

```typescript
import { classifyMcpPath } from '../../src/mcp-server/url-parser.js';

describe('classifyMcpPath — 路由决策（apiKey 登录已下线）', () => {
  it('/mcp → plain', () => {
    expect(classifyMcpPath('/mcp')).toEqual({ kind: 'plain' });
  });

  it('/mcp/API@userId@CJ:token → directToken', () => {
    const r = classifyMcpPath('/mcp/API@CJ4623764@CJ:tok123');
    expect(r).toEqual({
      kind: 'directToken',
      token: { userId: 'CJ4623764', accessToken: 'tok123' },
    });
  });

  it('/mcp/MCP@userId@CJ:token → directToken', () => {
    expect(classifyMcpPath('/mcp/MCP@CJ1@CJ:t')?.kind).toBe('directToken');
  });

  it('/mcp/{裸 apiKey} → reject（原 apiKey 模式已下线）', () => {
    const r = classifyMcpPath('/mcp/CJ5298622@apikey_xxx');
    expect(r?.kind).toBe('reject');
  });

  it('非 /mcp 路径 → undefined（交给上层 404）', () => {
    expect(classifyMcpPath('/health')).toBeUndefined();
    expect(classifyMcpPath('/')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/url-parser.test.ts`
Expected: FAIL — `classifyMcpPath is not a function`（导出不存在）

- [ ] **Step 3: 实现**（在 `src/mcp-server/url-parser.ts` 末尾追加）

```typescript
/** MCP 路由决策：plain=本地/密码登录会话；directToken=直连 Token；reject=已下线的 apiKey URL */
export type McpRouteDecision =
  | { kind: 'plain' }
  | { kind: 'directToken'; token: DirectTokenUrl }
  | { kind: 'reject'; reason: string };

/**
 * 判定 /mcp 路径的处理方式。
 * @note 下线 apiKey 登录: 原 /mcp/{apiKey} 自动认证已移除；除 /mcp 与直连 Token 外的
 *   /mcp/xxx 一律 reject（返回明确错误），不再当作 apiKey 去 getAccessToken。
 * @returns undefined 表示非 /mcp 路径（由调用方按 404 处理）
 */
export function classifyMcpPath(urlPath: string): McpRouteDecision | undefined {
  if (urlPath === '/mcp') return { kind: 'plain' };
  const token = parseDirectTokenUrl(urlPath);
  if (token) return { kind: 'directToken', token };
  if (/^\/mcp\/.+$/.test(urlPath)) {
    return {
      kind: 'reject',
      reason:
        'apiKey URL 登录已下线，请改用直连 Token URL: /mcp/API@<userId>@CJ:<accessToken>，' +
        '或使用 verify_credentials 以邮箱+密码登录。',
    };
  }
  return undefined;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/unit/url-parser.test.ts`
Expected: PASS（全部用例通过）

- [ ] **Step 5: 提交**

```bash
git add src/mcp-server/url-parser.ts tests/unit/url-parser.test.ts
git commit -m "feat(auth): add classifyMcpPath router (apiKey URL → reject)"
```

---

## Task 2: index.ts 路由改用 classifyMcpPath，删除 E1 自动认证

**Files:**
- Modify: `src/mcp-server/index.ts`（imports；删 `ensureApiKeySession`；重写 `requestHandler` 内 `/mcp` 路由）

- [ ] **Step 1: 改 imports**

把
```typescript
import { registerTools, handleToolCall, getToolsList } from './tools/index.js';
import { logger } from '../utils/logger.js';
import { registerResources, handleResourceRead, getResourcesList } from './resources/index.js';
import { apiKeyStorage, directTokenStorage } from '../auth/api-key-context.js';
import { getSession, refreshSession, createSession } from '../auth/session.js';
import { parseDirectTokenUrl } from './url-parser.js';
```
改为
```typescript
import { registerTools, handleToolCall, getToolsList } from './tools/index.js';
import { logger } from '../utils/logger.js';
import { registerResources, handleResourceRead, getResourcesList } from './resources/index.js';
import { directTokenStorage } from '../auth/api-key-context.js';
import { classifyMcpPath } from './url-parser.js';
```
（删除 `apiKeyStorage`、`getSession/refreshSession/createSession`、`parseDirectTokenUrl` 三处 import——它们仅被即将删除的 E1 代码使用。）

- [ ] **Step 2: 删除 `ensureApiKeySession` 整个函数**

删除 `src/mcp-server/index.ts` 中 `async function ensureApiKeySession(apiKey: string): Promise<void> { … }`（连同其上方 JSDoc，约 37-62 行）。

- [ ] **Step 3: 重写 `requestHandler` 内 `/mcp` 路由块**

将「`const urlPath = …` 起，到 `res.writeHead(404); res.end('Not Found');`」之间的整段（当前约 149-262 行）替换为：

```typescript
      const urlPath = (req.url ?? '/').split('?')[0];
      const route = classifyMcpPath(urlPath);

      // 已下线的 apiKey URL（/mcp/{非直连Token}）→ 显式 400
      if (route?.kind === 'reject') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: route.reason }));
        return;
      }

      if (route) {
        const urlDirectToken = route.kind === 'directToken' ? route.token : undefined;

        const mcpServer = createMCPServer();
        // stateless 模式：sessionIdGenerator=undefined（多 Pod 免会话保持，详见文件顶部说明）
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await mcpServer.connect(transport);

        if (req.method === 'GET') {
          const authTag = urlDirectToken ? `directToken(${urlDirectToken.userId})` : 'none';
          logger.raw(`[MCP-REQ] ${new Date().toISOString()} | GET(SSE) | auth=${authTag}`);
          const handleGet = () => transport.handleRequest(req, res, undefined);
          if (urlDirectToken) {
            await directTokenStorage.run(urlDirectToken, handleGet);
          } else {
            await handleGet();
          }
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of req as AsyncIterable<Buffer>) {
            chunks.push(chunk);
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            await transport.close();
            await mcpServer.close();
            return;
          }

          {
            const b = body as Record<string, unknown>;
            let rpcLabel = String(b?.method ?? '?');
            let argsSummary = '';
            if (b?.method === 'tools/call') {
              const params = b.params as Record<string, unknown>;
              rpcLabel = `tools/call:${params?.name}`;
              const args = params?.arguments as Record<string, unknown> | undefined;
              if (args && Object.keys(args).length > 0) {
                argsSummary = ` | args=[${Object.keys(args).join(',')}]`;
              }
            }
            const authTag = urlDirectToken ? ` | directToken(${urlDirectToken.userId})` : '';
            const id = (b as Record<string, unknown>)?.id != null ? `#${(b as Record<string, unknown>).id}` : '';
            logger.raw(`[MCP-REQ] ${new Date().toISOString()} | ${rpcLabel}${id}${authTag}${argsSummary}`);
          }

          const handlePost = () => transport.handleRequest(req, res, body);
          if (urlDirectToken) {
            await directTokenStorage.run(urlDirectToken, handlePost);
          } else {
            await handlePost();
          }
        }

        res.on('finish', async () => {
          await transport.close();
          await mcpServer.close();
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
```

- [ ] **Step 4: 构建验证（编译无残留引用）**

Run: `yarn build`
Expected: `Done in …s.`（exit 0）；无 `ensureApiKeySession`/`apiKeyStorage`/`urlApiKey` 报错

- [ ] **Step 5: 手动验证路由（HTTP）**

```bash
CJ_TRANSPORT=http CJ_ENV=test CJ_HTTP_PORT=3011 node dist/mcp-server/index.cjs &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3011/mcp/CJ5298622@apikey_x -d '{}'   # 期望 400
curl -s http://localhost:3011/health                                                                     # 期望 {"status":"ok",...}
kill %1
```
Expected: 裸 apiKey 路径返回 **400**；`/health` 正常。

- [ ] **Step 6: 提交**

```bash
git add src/mcp-server/index.ts
git commit -m "feat(auth): remove URL apiKey auto-auth (E1); reject bare apiKey path with 400"
```

---

## Task 3: 删除 E2 —— verify_credentials 的 apiKey 入参与分支

**Files:**
- Modify: `src/mcp-server/tools/auth.tool.ts`
- Test: `tests/unit/auth-tool.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `tests/unit/auth-tool.test.ts`，验证仅传 apiKey 时被拒、不再调用 createSession）

```typescript
it('verify_credentials 仅传 apiKey 时被拒绝（E2 已下线，不再换 token）', async () => {
  const { handleAuthTool } = await import('../../src/mcp-server/tools/auth.tool');
  const result = await handleAuthTool('verify_credentials', { apiKey: 'some_api_key' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/loginName|password|邮箱|密码/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/unit/auth-tool.test.ts -t "E2 已下线"`
Expected: FAIL — 当前代码进入 `if (apiKey)` 分支，返回成功/或调用 createSession，`isError` 非 true。

- [ ] **Step 3: 删 `verify_credentials` schema 里的 apiKey 入参**

在 `getAuthTools()` 的 `verify_credentials` 定义中：
- 删除 `apiKey: { type: 'string', description: '(可选) CJ OpenAPI Key…' }` 这一行（约 81 行）。
- 把 description（约 74 行）改为：`'验证用户登录凭据并建立会话：email/loginName + password 前端登录 / Verify credentials via email/loginName + password.'`

- [ ] **Step 4: 删 handleVerifyCredentials 的 apiKey 直登分支**

在 `handleVerifyCredentials`（约 436 行起）：
- 把解构 `const { loginName, email, password, apiKey } = …` 改为 `const { loginName, email, password } = args as { loginName?: string; email?: string; password?: string };`
- 删除整段 `if (apiKey) { … }`（约 447-472 行，含其上方 `@description apiKey 直登模式` 注释）。
- 保留其后的 `if (!effectiveLoginName || !password)` 校验及密码登录流程不变（E3 的 `createSession(effectiveLoginName!, apiKey, loginToken)` 在 webLogin 分支内，保持）。

- [ ] **Step 5: 删 show_login_form / check_login_status 里的 getContextApiKey 分支与文案**

- `show_login_form` 处理块（约 219-259 行）：删除 `const ctxApiKey = getContextApiKey();` 及其后的 `if (ctxApiKey && getSession()) { …「已通过 URL ApiKey 自动完成认证」… }` 分支；保留 `directCtx` 分支与末尾默认返回。
- `check_login_status`（约 766 行）：删除 `const ctxApiKey = getContextApiKey();`（该变量在删分支后不再使用）。
- 删除工具描述文案里提到 `/mcp/{apiKey}` 的行（约 58、62、90、92 行），改为只保留密码登录 / 直连 Token 引导。
- 改 import（约 29 行）：`import { getDirectTokenContext } from '../../auth/api-key-context.js';`（去掉 `getContextApiKey`）。
- 保留 `import { …, createSession, … }`（E3 仍用）。

- [ ] **Step 6: 运行确认通过 + 回归**

Run: `npx vitest run tests/unit/auth-tool.test.ts`
Expected: PASS——新用例通过；既有「webLogin 返回 apiKey 时调用 createSession」（E3）与「无 apiKey 用 setSessionDirect」用例仍通过。

- [ ] **Step 7: 提交**

```bash
git add src/mcp-server/tools/auth.tool.ts tests/unit/auth-tool.test.ts
git commit -m "feat(auth): remove apiKey param from verify_credentials (E2); drop URL-apiKey status branches"
```

---

## Task 4: resources/index.ts 去掉缓存键的 apiKey 分支

**Files:**
- Modify: `src/mcp-server/resources/index.ts`
- Test: `tests/unit/resources.test.ts`（既有 18 个用例应保持通过；它们只用 directToken/local，无需新增）

- [ ] **Step 1: 改 import 与 getUiCacheKey**

- import（约 7 行）：`import { getDirectTokenContext } from '../../auth/api-key-context.js';`（去掉 `getContextApiKey`）。
- `getUiCacheKey()` 改为：

```typescript
function getUiCacheKey(): string {
  const direct = getDirectTokenContext();
  if (direct) return `dt:${credentialHash(direct.accessToken)}`;
  return '__local__';
}
```
（删除 `const apiKey = getContextApiKey(); if (apiKey !== undefined) return \`ak:${apiKey}\`;` 两行，并订正上方 JSDoc 里关于 apiKey 分支的描述。）

- [ ] **Step 2: 运行确认回归通过**

Run: `npx vitest run tests/unit/resources.test.ts tests/unit/keyed-ttl-cache.test.ts`
Expected: PASS（resources 18 + store 6 全绿；隔离/滑动TTL/XSS 等不受影响）

- [ ] **Step 3: 提交**

```bash
git add src/mcp-server/resources/index.ts
git commit -m "refactor(cache): drop apiKey cache-key branch in getUiCacheKey"
```

---

## Task 5: 先让 api-key-url.test.ts 脱钩（删 apiKey-Map 用例，保留直连 Token）

**Files:**
- Modify: `tests/unit/api-key-url.test.ts`（整文件重写为下方内容）

> 顺序说明：先改这个测试（去掉对 `apiKeyStorage`/`cleanupExpiredApiKeySessions` 的依赖），再在 Task 6/7 删除这些导出，避免中间提交编译失败。重写后针对**当前**代码仍应全绿。

- [ ] **Step 1: 用以下内容整体替换 `tests/unit/api-key-url.test.ts`**

```typescript
/**
 * @fileoverview 直连 Token 会话单元测试
 * 覆盖：
 *  1. 无认证上下文时 getSession 返回 null（本地模式）
 *  2. 直接 Token 模式（/mcp/API@userId@CJ:token）：getSession 合成 session、ensureAccessToken 直接返回 token、isSessionValid=true
 * @note apiKey URL 登录（E1）已下线，相关会话隔离用例随之移除。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData } from '../../src/auth/session';

vi.mock('../../src/auth/token-store', () => ({
  TokenStore: class {
    static getInstance() { return new this(); }
    getToken() { return ''; }
    setToken() { /* noop */ }
    clearToken() { /* noop */ }
    hasToken() { return false; }
  },
}));

vi.mock('../../src/api-client/http-client', () => ({
  httpClient: { request: vi.fn() },
}));

vi.mock('../../src/config/env', () => ({
  getEnvConfig: () => ({
    env: 'test', openApiBase: '', webBase: '', loginApiBase: '',
    platform: 1, language: 'en', currency: 'USD', tokenEncryptKey: '',
  }),
}));

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
```

- [ ] **Step 2: 运行确认（对当前代码仍全绿）**

Run: `npx vitest run tests/unit/api-key-url.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 3: 提交**

```bash
git add tests/unit/api-key-url.test.ts
git commit -m "test(auth): drop apiKey-Map session tests; keep direct-token coverage"
```

---

## Task 6: session.ts 删除 apiKey 会话机制与分支

**Files:**
- Modify: `src/auth/session.ts`

- [ ] **Step 1: 删除 apiKeySessions、清理函数、定时器**

- 删除 `const apiKeySessions = new Map<string, SessionData>();`（约 28 行）及其上方注释。
- 删除整个 `export function cleanupExpiredApiKeySessions(): number { … }`（约 39-49 行）。
- 删除其下的 `const _cleanupTimer = setInterval(() => { … }, 30 * 60 * 1000).unref();`（约 53-59 行）。

- [ ] **Step 2: 删除各函数里的 ctxApiKey 分支**

- import（约 17 行）：改为 `import { getDirectTokenContext } from './api-key-context.js';`（去掉 `getContextApiKey`）。
- `getSession()`：删除
  ```typescript
  const ctxApiKey = getContextApiKey();
  if (ctxApiKey !== undefined) {
    return apiKeySessions.get(ctxApiKey) ?? null;
  }
  ```
  （保留 directCtx 分支、currentSession 分支、文件恢复分支。）
- `setSessionDirect()`：把
  ```typescript
  const ctxApiKey = getContextApiKey();
  if (ctxApiKey !== undefined) {
    apiKeySessions.set(ctxApiKey, session);
  } else {
    currentSession = session;
    tokenStore.setToken(JSON.stringify(session));
  }
  ```
  改为
  ```typescript
  currentSession = session;
  tokenStore.setToken(JSON.stringify(session));
  ```
- `createSession()`：同样把结尾的 `const ctxApiKey = …; if (ctxApiKey !== undefined) { apiKeySessions.set(...) } else { currentSession = …; tokenStore.setToken(...) }` 改为直接
  ```typescript
  currentSession = session;
  tokenStore.setToken(JSON.stringify(session));
  return session;
  ```
- `refreshSession()`：同样把 `const ctxApiKey = …; if (ctxApiKey !== undefined) { apiKeySessions.set(...) } else { currentSession=…; tokenStore.setToken(...) }` 改为
  ```typescript
  currentSession = session;
  tokenStore.setToken(JSON.stringify(session));
  ```
- `clearSession()`：把
  ```typescript
  const ctxApiKey = getContextApiKey();
  if (ctxApiKey !== undefined) {
    apiKeySessions.delete(ctxApiKey);
  } else {
    currentSession = null;
    tokenStore.clearToken();
  }
  ```
  改为
  ```typescript
  currentSession = null;
  tokenStore.clearToken();
  ```

> 保留：`createSession`、`getAccessToken`、`refreshSession`、`setSessionDirect`、`ensureAccessToken`、`getSession`、`isSessionValid`、`isAccessTokenExpired`，以及全部 `getDirectTokenContext()` 直连 Token 分支。

- [ ] **Step 3: 构建 + 会话相关测试**

Run: `yarn build && npx vitest run tests/unit/api-key-url.test.ts tests/unit/auth-tool.test.ts`
Expected: `Done`（构建 0）；两个测试文件全绿。

- [ ] **Step 4: 提交**

```bash
git add src/auth/session.ts
git commit -m "refactor(auth): remove apiKeySessions map, cleanup timer, and apiKey context branches"
```

---

## Task 7: api-key-context.ts 删除 apiKeyStorage / getContextApiKey

**Files:**
- Modify: `src/auth/api-key-context.ts`

> 前置：此时 `apiKeyStorage` 与 `getContextApiKey` 在 src 与 tests 中应已无引用（Task 2/3/4/5/6 已清）。本任务删除定义。

- [ ] **Step 1: 确认无残留引用**

Run: `grep -rn "apiKeyStorage\|getContextApiKey" src/ tests/`
Expected: 无输出（若有，回到对应任务清理）。

- [ ] **Step 2: 删除导出**

- 删除 `export const apiKeyStorage = new AsyncLocalStorage<string>();`
- 删除整个 `export function getContextApiKey(): string | undefined { return apiKeyStorage.getStore(); }` 及其注释。
- 更新文件头 JSDoc：移除「apiKey 模式」小节，仅保留「直接 Token 模式」说明。
- 保留 `import { AsyncLocalStorage } from 'node:async_hooks';`（`directTokenStorage` 仍用）。

- [ ] **Step 3: 构建 + 全量测试**

Run: `yarn build && npx vitest run`
Expected: 构建 0；测试 `3 failed`（既有与本次无关的 auth-tool resourceUri 基线失败）以外全绿，无因缺失导出导致的新失败。

- [ ] **Step 4: 提交**

```bash
git add src/auth/api-key-context.ts
git commit -m "refactor(auth): drop apiKeyStorage and getContextApiKey"
```

---

## Task 8: 最终验证与文档

**Files:**
- （无代码）验证 + 可选文档更新

- [ ] **Step 1: 全链路验证**

```bash
npx tsc --noEmit 2>&1 | grep -c 'error TS'   # 期望 ≤ 基线 10（应更少：删了 apiKey 代码）
npx vitest run 2>&1 | grep -E 'Tests +[0-9]'  # 期望 3 failed（基线）其余全绿
yarn build 2>&1 | tail -2                      # 期望 Done, exit 0
grep -rn "ensureApiKeySession\|apiKeySessions\|apiKeyStorage\|getContextApiKey\|cleanupExpiredApiKeySessions" src/ tests/  # 期望空
```

- [ ] **Step 2: 手动冒烟（HTTP，三条路径）**

```bash
CJ_TRANSPORT=http CJ_ENV=test CJ_HTTP_PORT=3012 node dist/mcp-server/index.cjs &
sleep 1
curl -s -o /dev/null -w "bare-apikey=%{http_code}\n" -X POST http://localhost:3012/mcp/CJxxx@apikey_y -d '{}'   # 期望 400
curl -s -o /dev/null -w "direct-token=%{http_code}\n" -X POST 'http://localhost:3012/mcp/API@CJ1@CJ:tok' \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}'          # 期望 200
kill %1
```
Expected: 裸 apiKey → 400；直连 Token → 200。

- [ ] **Step 3: （可选）更新对外文档**

若 README / 使用说明中记载了 `/mcp/{apiKey}` 或 verify_credentials 的 apiKey 用法，更新为「直连 Token URL / 密码登录」。（`grep -rn "/mcp/{apiKey}\|apiKey" README* docs/` 排查。）

- [ ] **Step 4: 收尾提交**

```bash
git add -A
git commit -m "docs(auth): update guidance after removing apiKey login (E1+E2)"
```

---

## 验收标准

- `/mcp/{裸 apiKey}` 返回 **400** 明确错误；`/mcp/API@…@CJ:token` 与 `/mcp` 正常。
- `verify_credentials` 仅接受 `loginName/email + password`；传 `apiKey` 被拒。
- 密码登录（含 webLogin 返回账号 apiKey 的 E3 分支、以及无 apiKey 的 setSessionDirect 分支）保持可用。
- `src/`、`tests/` 中无 `ensureApiKeySession`/`apiKeySessions`/`apiKeyStorage`/`getContextApiKey`/`cleanupExpiredApiKeySessions` 残留。
- `yarn build` 通过；`tsc` 错误数不高于基线 10；vitest 除既有 3 个基线失败外全绿。
