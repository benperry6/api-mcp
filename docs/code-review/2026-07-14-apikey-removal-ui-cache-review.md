# 代码评审报告：apiKey 登录下线 + 同步兜底移除 + 每用户 UI 缓存

- **日期**：2026-07-14
- **评审对象**：当前工作区未提交改动（`git diff HEAD`，仅 `src/**/*.ts` 与 `tests/**/*.ts`）
- **规模**：12 个文件，+721 / −504
- **方式**：xhigh 多角度评审工作流 —— 8 个独立 finder 视角并行 → 去重 → 逐条**对抗验证**（每条尝试证伪）
- **结果**：17 候选 → **3 证伪(refuted) / 7 CONFIRMED / 7 PLAUSIBLE**
- **客观态**：`tsc` 10 个错误（基线，无新增）、`vitest` 122 passed / 3 failed（3 = 既有 `wait_for_login` 基线失败，与本次无关）、`yarn build` exit 0

> 说明：本次评审的是"撤销有状态改造之后"的工作区。有状态/keep-alive/`session-registry.ts` 已全部回退，全仓无残留。

---

## 一、改动摘要（被评审内容）

| 类别 | 文件 | 说明 |
|------|------|------|
| apiKey 下线 E1 | `mcp-server/index.ts`、`url-parser.ts` | 移除 `/mcp/{apiKey}` URL 自动认证；裸 apiKey 路径经 `classifyMcpPath` 归入 reject → HTTP 400。新增纯函数 `classifyMcpPath`（plain/directToken/reject） |
| apiKey 下线 E2 | `tools/auth.tool.ts` | `verify_credentials` 移除 `apiKey` 参数；仅传 apiKey 时提示"已下线" |
| apiKey 机制清理 | `auth/session.ts`、`auth/api-key-context.ts` | 删除 `apiKeySessions` Map 及清理定时器、`SessionData.apiKey`、`apiKeyStorage`/`getContextApiKey`。保留：密码登录、直连 Token URL、内部 webLogin→apiKey→accessToken 兑换（E3），以及 `createSession(apiKey)` 请求体入参 |
| 性能 | `mcp-server/resources/index.ts` | 移除读 UI 模板时的 ~4s 同步兜底拉数（`fetchProductListFallback`/`fetchOrderListFallback`） |
| 缓存 | `utils/keyed-ttl-cache.ts`（新）、`resources/index.ts` | 引入 `KeyedTtlStore`（滑动 TTL + LRU + 惰性过期）；UI 缓存改为**按凭证 hash 分桶**（`dt:sha256(accessToken)`），非直连走 `__local__` |
| 安全修复 | `resources/index.ts` | inline `<script>` 注入 XSS 转义（`toInlineScriptJson`）；函数式 `replace` 规避 `$&/$'/$\`/$$` 污染；`resolveMaxUsers` env 校验 |

---

## 二、总体结论

**改动本身没有引入新的安全回归**，且在缓存维度上**改善了隔离**（直连 Token 从"全模块共享标量"变为"按 accessToken hash 分桶"）。tsc/构建无新增问题。

**唯一实质性问题**是一个**长期存在、本次未修复、且被新注释掩盖**的隔离缺口：**HTTP 部署下走"明文 `/mcp` + 密码登录"的多个用户共享进程级全局 `currentSession` 与单一 `__local__` UI 缓存桶**（下述 S1）。其余为测试覆盖缺口与清理项。

建议优先处理：**S1 的注释纠偏 + 明确密码登录在多用户 HTTP 下的定位**；其次补 T1（`__local__` 往返回归测试）。清理项可选。

---

## 三、CONFIRMED（7 条，已对抗验证确认）

### 🔴 S1（MEDIUM · security）密码登录走 HTTP 未做租户隔离，且新注释夸大为"单用户安全"
- **位置**：`src/mcp-server/resources/index.ts:133`（注释）；根因在 `src/auth/session.ts:35,97,132` 的模块级 `currentSession`
- **场景**：多用户共用的公网 `/mcp`（明文，非直连 Token）上，用户 A、B 各自 `verify_credentials(loginName/password)`。二者都写模块级 `currentSession`、都读写 `getUiCacheKey()=='__local__'`。B 登录后覆盖 `currentSession`，A 后续 `getAccessToken()` 拿到 **B 的 OpenAPI token**，`getProductListCache()/getOrderListCache()` 读到 **B 的商品/订单** —— 跨用户 token + 数据泄露。
- **验证要点（务必如实理解）**：
  1. `currentSession` 共享是**纯既有问题** —— 本次 `session.ts` 的 diff 只删了 `apiKeySessions` Map，没动这个全局。
  2. 本次改动实际上**改善了缓存侧**（直连 Token 现按 `sha256(accessToken)` 隔离，之前所有模式共享模块级标量）。
  3. **本次 diff 自身的过错，仅是那条误导性注释** `resources/index.ts:133-134`"非直连 Token 的请求（本地/密码登录单用户）统一用 `__local__`"—— 它断言了密码登录在 HTTP 多用户下并不具备的"单用户"隔离。
- **建议**：① 立即纠正注释，不要宣称密码登录 HTTP 路径是单用户安全；② 从产品上明确：多用户远程（ChatGPT）应走**直连 Token URL**（已隔离），密码登录仅用于本地/单用户（stdio）；若要在 HTTP 支持多用户密码登录，需把 `currentSession` + `__local__` 也做成按凭证分桶（与直连 Token 一致）。

> S1 与下面 PLAUSIBLE 的 P1/P4/P5 是**同一问题的不同视角**，此处合并陈述。

### 🟡 T1（MEDIUM · test-coverage）`__local__` 缓存桶从未做"写入→读回"断言
- **位置**：`tests/unit/resources.test.ts:88`
- **场景**：所有缓存测试都在 `directTokenStorage.run(...)` 内跑，只覆盖 `dt:` 分支；没有任一测试在**无 directToken 上下文**下写入再读回。若 `__local__` 分支回归（抛错 / 每次返回不同 key），stdio/密码登录用户会**静默丢失全部 UI 缓存**（`__INITIAL_DATA__` 永不注入）而全套测试仍绿。`__local__` 是 stdio 下的**主路径**。
- **建议**：加一条不在 directToken 上下文中的 `set→get` 往返用例。

### 🟢 T2（LOW · test-coverage）E1 的 400 落地（reason 文案 + index.ts 接线）无测试
- **位置**：`tests/unit/url-parser.test.ts:69`
- **场景**：测试只断言 `r?.kind === 'reject'`，从不校验 `reason`；也无任何测试覆盖 index.ts 把 `route.kind==='reject'` 映射到 `writeHead(400)+JSON`。若该 index.ts 分支被删，裸 apiKey URL 会**当作未认证 plain 会话返回 200**，无测试拦截。分类逻辑本身（纯函数）已覆盖，缺的是文案与 HTTP 接线。
- **建议**：补一条 index.ts 层的集成断言（或至少断言 `reason` 非空）。

### 🟢 T3（LOW · test-coverage）`order-detail` 的注入/XSS 分支无测试
- **位置**：`tests/unit/resources.test.ts:243`
- **场景**：`order-detail` 有独立的 `if(detailData)` + `toInlineScriptJson` + 函数式 replace 注入分支；当前只测了 `product-list`、`product-detail` 的 XSS。若该分支被改回字符串式 replace 或丢掉转义，卖家可控的 `</script>` 会逃逸而无测试捕获。
- **建议**：给 `order-detail`（及 `order-list`）补 XSS 注入用例。

### 🟢 C1（LOW · simplification）directToken 上下文包裹在 GET/POST 路径重复
- **位置**：`src/mcp-server/index.ts:153`（与 197 重复）
- **说明**：`if (urlDirectToken) await directTokenStorage.run(...); else await fn();` 两处逐字重复。抽 `runInCtx(fn)` 一处。

### 🟢 C2（LOW · simplification）四个 UI 资源分支 4-路复制粘贴
- **位置**：`src/mcp-server/resources/index.ts:284`
- **说明**：`product-list/product-detail/order-detail/order-list` 四块仅差 uri 前缀、缓存 getter、html 文件名。改为查表 `[{prefix,file,get}]` + 单个 `renderDataUi()`，~56 行收敛到 ~15 行，并让 XSS 安全的 `__INITIAL_DATA__` 注入**只有一处**而非四处需保持一致。

### 🟢 C3（LOW · altitude）`hasProductDetailCache` 为无人调用的死导出
- **位置**：`src/mcp-server/resources/index.ts:196`
- **说明**：`src/` 内仅有定义处与 `product.tool.ts:20` 的 import，无任何调用点。它现在还为不存在的消费者做了一次每用户缓存查询。建议移除导出并从 import 清掉。

---

## 四、PLAUSIBLE（7 条，真实但影响未完全坐实）

| # | 严重度 | 位置 | 摘要 |
|---|--------|------|------|
| P1/P4/P5 | MEDIUM/LOW · security | `resources/index.ts:139`、`session.ts:97` | 与 **S1 同源**：非直连全部塌陷到 `__local__` + 全局 `currentSession`，HTTP 密码登录非租户隔离；根因既有，本次注释放大了误导 |
| P2 | MEDIUM · test-coverage | `tests/unit/resources.test.ts:47` | "不触发后端"回归测试的冷缓存 priming（`setXCache(null)`）写在 `__local__` 桶，而断言读 `dt:` 桶 → priming 打空，可能**空转通过**、未真正守住"移除同步兜底"这个修复 |
| P3 | LOW · removed-behavior | `tools/auth.tool.ts:792` | `logout`/`clearSession` 未对直连 Token（stateless）上下文加保护：直连用户触发 logout 会清掉共享的全局 `currentSession` 与持久化 token 文件，殃及同进程的本地/密码用户 |
| P6 | LOW · test-coverage | `tests/unit/resources.test.ts:66` | `spy.mockRestore()` 放在用例体末尾而非 `finally`；断言中途抛错会把 `httpClient.request`/`fetch` 的 stub 泄漏给后续测试 |
| P7 | LOW · test-coverage | `tests/unit/resources.test.ts` | 模块单例 `uiCache` 无逐测重置，多个用例复用 accessToken `'t'`（同 `dt:hash` key），隔离依赖"每个测试先写后读"；将来只读不写的用例会读到前一测试残留 → 顺序相关的假通过/假失败 |

---

## 五、已证伪（3 条）

对抗验证阶段有 **3 个候选被证伪**（复核代码后判定不成立或不适用），未纳入上表。

---

## 六、处置建议（按性价比）

1. **必做**：纠正 `resources/index.ts:133-134` 的误导性注释；在文档/产品层明确"HTTP 多用户 → 直连 Token URL；密码登录 → 本地/单用户"。（S1 / P1 / P4 / P5）
2. **建议**：补 `__local__` 往返回归测试（T1）、修正 P2 的冷缓存 priming 让它真正落在被断言的桶。
3. **可选**：T2/T3 补测试；C1/C2/C3 清理（抽 `runInCtx`、四分支合并、删死导出）；P3 给 logout 加直连上下文保护；P6/P7 测试卫生（`finally` 复原 + 逐测重置 `uiCache`）。

> 注：本报告仅评审与记录，未改动任何代码；git 未操作。评审工作流：25 个 subagent、约 163.5 万 token、0 错误。
