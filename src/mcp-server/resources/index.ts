/**
 * @fileoverview Resources 注册中心
 * 管理 MCP UI Resources (如登录页面)
 */
import { readUiHtmlFile } from '../../utils/module-path.js';
import { logger } from '../../utils/logger.js';
import { getDirectTokenContext } from '../../auth/api-key-context.js';
import { KeyedTtlStore } from '../../utils/keyed-ttl-cache.js';
import { createHash } from 'node:crypto';

/** Cursor / MCP Apps 规范要求的 HTML UI 资源 MIME 类型（纯 text/html 会报 Unsupported UI resource type） */
export const MCP_APP_HTML_MIME = 'text/html;profile=mcp-app';

/**
 * MCP Apps 沙箱 CSP：未声明时 Host 默认 img-src 仅 'self' data:，远程 CDN 图片会被拦截。
 * ChatGPT 可能合并额外白名单；Cursor / Codex 严格按 _meta.ui.csp 执行。
 * @see https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx
 */
export const CJ_MCP_UI_CSP = {
  resourceDomains: [
    'https://cf.cjdropshipping.com',
    'https://frontend.cjdropshipping.com',
    'https://www.cjdropshipping.com',
    'https://cjdropshipping.com',
    'https://*.cjdropshipping.com',
    // 测试环境静态资源 / login API
    'http://www.cjdropshipping.offline.pre.com',
    'http://*.cjdropshipping.offline.pre.com',
  ],
  connectDomains: [
    'https://www.cjdropshipping.com',
    'https://developers.cjdropshipping.com',
    'https://*.cjdropshipping.com',
    'http://www.cjdropshipping.offline.pre.com',
    'http://developers.cjdropshipping.offline.pre.com',
    'http://*.cjdropshipping.offline.pre.com',
  ],
} as const;

const CJ_MCP_UI_META = { ui: { csp: CJ_MCP_UI_CSP } } as const;

interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  _meta?: typeof CJ_MCP_UI_META;
}

interface McpAppResourceContent {
  uri: string;
  mimeType: string;
  text: string;
  _meta: typeof CJ_MCP_UI_META;
}

interface ResourceContent {
  contents: McpAppResourceContent[];
}

/** 构造带 CSP 声明的 MCP App HTML 资源内容 */
function buildMcpAppHtmlContent(uri: string, htmlContent: string): McpAppResourceContent {
  return {
    uri,
    mimeType: MCP_APP_HTML_MIME,
    text: htmlContent,
    _meta: CJ_MCP_UI_META,
  };
}

/**
 * 将数据序列化为可安全嵌入内联 <script> 的 JSON 字符串。
 * @note 纠正(#1 XSS): JSON.stringify 不转义 < > 及行分隔符 U+2028/U+2029，
 *   直接拼进 <script> 时，数据(第三方卖家可控的商品/订单文本)里的 </script> 会提前闭合
 *   脚本标签，造成 HTML/脚本逃逸(存储型 XSS)。这里额外把这些字符转成 \uXXXX 转义
 *   （仍是合法 JSON，浏览器 JSON/JS 解析后取值不变），从根源阻断标签逃逸。
 */
function toInlineScriptJson(data: unknown): string {
  return (JSON.stringify(data) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * @note 纠正(线上服务重启-数据隔离 / #3 / #5): 原为模块级全局标量，HTTP 多用户并发下会串数据
 *   （用户 A 的 search_products 结果被用户 B 的 show_ 工具或资源读取读到）。
 *   现按「当前请求的用户身份」分桶存储：直连Token→dt:hash(accessToken)，
 *   非直连（裸 /mcp）→__local__。
 *   ⚠️ 隔离边界（重要）：只有【直连 Token】模式按凭证哈希做到了用户间隔离；
 *   【非直连 /mcp】（密码登录 / stdio）全部落到同一个 __local__ 桶，且共享进程级全局
 *   currentSession（见 auth/session.ts）。因此 __local__ 仅对「真正单用户」部署安全
 *   （stdio 本地、或单人使用）。HTTP 多用户下走密码登录并【不】隔离——A、B 会互相覆盖
 *   currentSession、共读 __local__ 桶。多用户远程（ChatGPT）请使用直连 Token URL。
 *   （apiKey URL 模式已下线，原 ak:apiKey 桶随之移除。）
 *   通用的「滑动 TTL + 容量上限 + 过期清理」逻辑抽到 KeyedTtlStore（utils/keyed-ttl-cache.ts）：
 *   - #2 滑动 TTL：get/set 均续期，活跃会话（持续查看 UI）不会被定时清理误删；
 *   - #3 容量上限：默认最多 500 个用户桶（env CJ_UI_CACHE_MAX_USERS 可调），
 *     超限驱逐最久未活动者，防止并发用户激增时内存无限增长。
 */
interface UserUiData {
  productList?: unknown;
  productDetail?: unknown;
  orderList?: unknown;
  orderDetail?: unknown;
}

const UI_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * 解析 CJ_UI_CACHE_MAX_USERS：仅接受正整数，否则回退默认值。
 * @note 纠正(#5): 原 `Number(raw) || 500` 会让负数(如 -1)原样透传给 maxEntries，
 *   使容量上限退化/抖动；非正、非整、NaN 一律回退默认 500。
 */
export function resolveMaxUsers(raw: string | undefined, fallback = 500): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const UI_CACHE_MAX_USERS = resolveMaxUsers(process.env.CJ_UI_CACHE_MAX_USERS);
const uiCache = new KeyedTtlStore<UserUiData>({
  ttlMs: UI_CACHE_TTL_MS,
  maxEntries: UI_CACHE_MAX_USERS,
});

/** 取凭证的短哈希，用作缓存键（避免把明文 token 直接当键，且长度可控） */
function credentialHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/**
 * 生成当前请求的用户缓存键。
 * @note 纠正(#3): 直连 Token 模式改用 accessToken 的哈希做键，而非 URL 里的 userId。
 *   userId 来自 URL 路径、未与 token 绑定；若以 userId 为键，攻击者用
 *   /mcp/API@受害者ID@CJ:自己的token 就会命中受害者的缓存桶，读到其商品/订单数据。
 *   accessToken 才是真正的凭证，以其哈希为键可保证不同凭证互相隔离。
 * @note 下线 apiKey 登录: 原 ak:{apiKey} 分支随 URL apiKey 模式一并移除。
 * @note 隔离边界: 非直连 Token 的请求一律返回常量 __local__，即所有密码登录 / stdio 请求
 *   共用同一个桶（并共享全局 currentSession）。这只对真正单用户部署（stdio/单人）安全；
 *   HTTP 多用户下密码登录并不隔离，多用户远程请改用直连 Token URL。详见文件顶部说明。
 */
function getUiCacheKey(): string {
  const direct = getDirectTokenContext();
  if (direct) return `dt:${credentialHash(direct.accessToken)}`;
  return '__local__';
}

/** 读当前用户的 UI 数据桶（get 会滑动 TTL）；不存在返回 undefined */
function readUiData(): UserUiData | undefined {
  return uiCache.get(getUiCacheKey());
}

/** 读改写当前用户的 UI 数据桶（set 会滑动 TTL 并执行容量上限驱逐） */
function writeUiData(mutate: (bucket: UserUiData) => void): void {
  const key = getUiCacheKey();
  const bucket = uiCache.get(key) ?? {};
  mutate(bucket);
  uiCache.set(key, bucket);
}

/**
 * 清理已过期的用户 UI 缓存，防止长期运行时无限增长。
 * 由 setInterval 每 30 分钟自动调用，也可手动调用（便于测试）。
 * @returns 本次清理的条目数
 */
export function cleanupExpiredUiCache(): number {
  return uiCache.cleanupExpired();
}

// 每 30 分钟自动清理一次；unref() 确保此定时器不阻止进程正常退出
setInterval(() => {
  cleanupExpiredUiCache();
}, UI_CACHE_TTL_MS).unref();

export function setProductListCache(data: unknown): void {
  writeUiData((b) => {
    b.productList = data;
  });
}

/**
 * @note 供 show_product_list 读取「当前用户」缓存数据，注入 structuredContent，
 * 通过 MCP Apps ui/notifications/tool-result 协议推送到 iframe。
 */
export function getProductListCache(): unknown {
  return readUiData()?.productList ?? null;
}

export function setProductDetailCache(data: unknown): void {
  writeUiData((b) => {
    b.productDetail = data;
  });
}

/**
 * @note 供 show_product_detail 读取「当前用户」缓存数据，注入 structuredContent 推送。
 */
export function getProductDetailCache(): unknown {
  return readUiData()?.productDetail ?? null;
}

export function hasProductDetailCache(): boolean {
  return readUiData()?.productDetail != null;
}

export function setOrderListCache(data: unknown): void {
  writeUiData((b) => {
    b.orderList = data;
  });
}

/**
 * @note 供 show_order_list 读取「当前用户」缓存数据，注入 structuredContent 推送。
 */
export function getOrderListCache(): unknown {
  return readUiData()?.orderList ?? null;
}

export function setOrderDetailCache(data: unknown): void {
  writeUiData((b) => {
    b.orderDetail = data;
  });
}

/**
 * @note 供 show_order_detail 读取「当前用户」缓存数据，注入 structuredContent 推送。
 */
export function getOrderDetailCache(): unknown {
  return readUiData()?.orderDetail ?? null;
}

const resources: Resource[] = [
  {
    uri: 'ui://cj-mcp/login',
    name: 'CJ Login Form',
    description: 'Interactive login form for CJ Dropshipping / CJ登录页面',
    mimeType: MCP_APP_HTML_MIME,
    _meta: CJ_MCP_UI_META,
  },
  {
    uri: 'ui://cj-mcp/product-list',
    name: 'CJ Product List',
    description: 'Interactive product list viewer. Use this to display search_products results in a visual card layout. / 商品列表展示页面，用于以卡片方式可视化展示商品搜索结果。',
    mimeType: MCP_APP_HTML_MIME,
    _meta: CJ_MCP_UI_META,
  },
  {
    uri: 'ui://cj-mcp/product-detail',
    name: 'CJ Product Detail',
    description: 'Interactive product detail viewer. Use this to display get_product_detail results with images, variants, and pricing. / 商品详情展示页面，用于展示商品图片、规格和价格信息。',
    mimeType: MCP_APP_HTML_MIME,
    _meta: CJ_MCP_UI_META,
  },
  {
    uri: 'ui://cj-mcp/order-list',
    name: 'CJ Order List',
    description: 'Visual order list viewer. Displays order status, amounts, logistics and shipping info. / 订单列表展示页面，以卡片方式展示订单状态、金额、物流等信息。',
    mimeType: MCP_APP_HTML_MIME,
    _meta: CJ_MCP_UI_META,
  },
  {
    uri: 'ui://cj-mcp/order-detail',
    name: 'CJ Order Detail',
    description: 'Visual order detail viewer. Displays full order info: status, address, product list, logistics, amounts. / 订单详情展示页面，展示订单状态、收货地址、商品清单、物流信息等完整详情。',
    mimeType: MCP_APP_HTML_MIME,
    _meta: CJ_MCP_UI_META,
  },
];

export function registerResources(): void {
  // Resources are statically defined
}

export function getResourcesList(): Resource[] {
  return resources;
}

export async function handleResourceRead(uri: string): Promise<ResourceContent> {
  /**
   * @note 纠正(72次): 改用前缀匹配替代精确匹配。
   * 原因：getAuthTools() 现在为 wait_for_login 注入唯一时间戳 URI（如 ui://cj-mcp/login?t=1716123456789），
   * 确保 VS Code Copilot 每次在当前对话位置创建新登录 UI，而不是复用旧的 UI 元素。
   * 服务端读取时，只需识别基础路径 'ui://cj-mcp/login' 前缀即可，查询参数仅用于客户端唯一性标识。
   */
  if (uri.startsWith('ui://cj-mcp/login')) {
    const htmlContent = readUiHtmlFile('login.html');
    return { contents: [buildMcpAppHtmlContent(uri, htmlContent)] };
  }

  if (uri.startsWith('ui://cj-mcp/product-list')) {
    /**
     * @note 纠正(线上服务重启-性能): 移除读模板时的同步兜底拉数据。
     *   原因：预取 UI 模板阶段同步调用 product/listV2 会阻塞返回（线上观测到 ~4s），
     *   而真实数据本就通过工具调用后的 ui/notifications/tool-result 推送给 iframe。
     *   现改为：模板立即返回，仅当缓存已被真实工具调用填充时才注入 __INITIAL_DATA__，
     *   冷缓存则返回不带初始数据的模板，零额外后端请求。
     */
    const listData = getProductListCache();
    logger.debug(`[RESOURCE] product-list requested, cache=${listData != null ? 'HIT' : 'MISS'}`);
    let htmlContent = readUiHtmlFile('product-list.html');
    if (listData) {
      const initScript = `<script>window.__INITIAL_DATA__ = ${toInlineScriptJson(listData)};</script>`;
      // @note 纠正(#1): 用函数式 replace，避免注入数据中的 $&/$'/$` 等被当成替换模式解释
      htmlContent = htmlContent.replace('</head>', () => `${initScript}\n</head>`);
    }
    return { contents: [buildMcpAppHtmlContent(uri, htmlContent)] };
  }

  if (uri.startsWith('ui://cj-mcp/product-detail')) {
    const detailData = getProductDetailCache();
    logger.debug(`[RESOURCE] product-detail requested, cache=${detailData != null ? 'HIT' : 'MISS'}`);
    let htmlContent = readUiHtmlFile('product-detail.html');
    if (detailData) {
      const initScript = `<script>window.__INITIAL_DATA__ = ${toInlineScriptJson(detailData)};</script>`;
      // @note 纠正(#1): 用函数式 replace，避免注入数据中的 $&/$'/$` 等被当成替换模式解释
      htmlContent = htmlContent.replace('</head>', () => `${initScript}\n</head>`);
    }
    return { contents: [buildMcpAppHtmlContent(uri, htmlContent)] };
  }

  if (uri.startsWith('ui://cj-mcp/order-detail')) {
    const detailData = getOrderDetailCache();
    logger.debug(`[RESOURCE] order-detail requested, cache=${detailData != null ? 'HIT' : 'MISS'}`);
    let htmlContent = readUiHtmlFile('order-detail.html');
    if (detailData) {
      const initScript = `<script>window.__INITIAL_DATA__ = ${toInlineScriptJson(detailData)};</script>`;
      // @note 纠正(#1): 用函数式 replace，避免注入数据中的 $&/$'/$` 等被当成替换模式解释
      htmlContent = htmlContent.replace('</head>', () => `${initScript}\n</head>`);
    }
    return { contents: [buildMcpAppHtmlContent(uri, htmlContent)] };
  }

  if (uri.startsWith('ui://cj-mcp/order-list')) {
    /**
     * @note 纠正(线上服务重启-性能): 移除读模板时的同步兜底拉数据（原 fetchOrderListFallback）。
     *   与 product-list 同理：预取阶段不再同步打后端接口，数据经 tool-result 推送。
     */
    const listData = getOrderListCache();
    logger.debug(`[RESOURCE] order-list requested, cache=${listData != null ? 'HIT' : 'MISS'}`);
    let htmlContent = readUiHtmlFile('order-list.html');
    if (listData) {
      const initScript = `<script>window.__INITIAL_DATA__ = ${toInlineScriptJson(listData)};</script>`;
      // @note 纠正(#1): 用函数式 replace，避免注入数据中的 $&/$'/$` 等被当成替换模式解释
      htmlContent = htmlContent.replace('</head>', () => `${initScript}\n</head>`);
    }
    return { contents: [buildMcpAppHtmlContent(uri, htmlContent)] };
  }

  throw new Error(`Unknown resource: ${uri}`);
}
