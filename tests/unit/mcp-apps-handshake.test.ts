/**
 * @fileoverview MCP Apps UI 握手契约测试（真实执行页面脚本，非字符串匹配）
 *
 * 背景（Claude App 的渲染生命周期）：
 *   Claude 渲染 MCP Apps UI 时不会直接显示 iframe，而是先给 iframe 外层 div 设
 *   style="visibility: hidden"，等 UI 完成握手后才置为 visible（目的是避免加载闪烁）。
 *   若 UI 始终没有发出"初始化完成"信号，外层 div 就**永久保持 hidden**——
 *   表现为「工具提示界面已打开，但界面完全看不到」。
 *
 * 真实故障：login.html 发出了 ui/initialize 请求，但
 *   1) 它的 sendRequest 没有响应回调（无 _pending 映射）；
 *   2) 唯一会发完成通知的分支判断 `msg.method === 'ui/initialize'`，
 *      而 JSON-RPC【响应】没有 method 字段，永不命中；
 *   3) 即便命中，它发的名字是 ui/initialized，而规范是 ui/notifications/initialized。
 *   结果 ui/notifications/initialized 永远发不出去 → 登录界面在 Claude 中永久隐藏。
 *   同目录另外 4 个 UI 页面（product/order）握手正确，所以只有登录页不显示。
 *
 * @see https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx
 *   规范要求：View 发送 ui/initialize 请求，收到响应后发送 ui/notifications/initialized 通知；
 *   且 "The Host MUST NOT send any request or notification to the View before it receives
 *   an initialized notification." —— 握手未完成，宿主不会与该 View 通信。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

/** 所有需要遵守 MCP Apps 握手契约的 UI 页面 */
const UI_PAGES = [
  'login.html',
  'product-list.html',
  'product-detail.html',
  'order-list.html',
  'order-detail.html',
] as const;

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

/** 造一个足够用的假 DOM 元素（页面脚本只做 addEventListener / 赋值等操作） */
function makeEl(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    focus: () => {},
    click: () => {},
    reset: () => {},
    remove: () => {},
    style: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    dataset: {},
    children: [],
  };
  for (const p of ['innerHTML', 'textContent', 'value', 'className', 'disabled', 'src', 'href']) {
    Object.defineProperty(el, p, { get: () => '', set: () => {}, configurable: true });
  }
  return el;
}

interface RunResult {
  /** 页面通过 window.parent.postMessage 发出的全部消息（按顺序） */
  posted: JsonRpcMsg[];
  /** 把一条消息投递给页面注册的 message 监听器 */
  dispatch(data: JsonRpcMsg): void;
}

/**
 * 在 vm 中真实执行某个 UI 页面的 <script>，捕获它 postMessage 出去的消息。
 * @param file UI 文件名
 * @param inIframe false 时令 window.parent === window，用于验证"非 iframe 环境不启用协议"
 */
function runUiScript(file: string, inIframe = true): RunResult {
  const html = readFileSync(resolve(__dirname, '../../src/ui', file), 'utf-8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(scripts.length, `${file} 应至少含一个 <script> 块`).toBeGreaterThan(0);

  const posted: JsonRpcMsg[] = [];
  const listeners: Record<string, Array<(e: { data: JsonRpcMsg }) => void>> = {};

  const parentObj = { postMessage: (m: JsonRpcMsg) => { posted.push(m); } };
  const win: Record<string, unknown> = {
    addEventListener: (t: string, fn: (e: { data: JsonRpcMsg }) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    removeEventListener: (t: string, fn: unknown) => {
      listeners[t] = (listeners[t] || []).filter(f => f !== fn);
    },
    location: { href: 'ui://cj-mcp/test', search: '' },
    __INITIAL_DATA__: undefined,
  };
  // inIframe=false 时 parent 指向 window 自身，页面应据此跳过协议初始化
  win.parent = inIframe ? parentObj : win;
  win.self = win;

  const doc: Record<string, unknown> = {
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: () => {},
    body: makeEl(),
    head: makeEl(),
    readyState: 'complete',
  };

  const sandbox = {
    window: win,
    document: doc,
    parent: win.parent,
    location: win.location,
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.reject(new Error('fetch not available in test')),
    JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
    encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
  };

  for (const code of scripts) {
    vm.runInNewContext(code, sandbox, { timeout: 5000, filename: file });
  }

  return {
    posted,
    dispatch(data: JsonRpcMsg) {
      for (const fn of listeners.message || []) fn({ data });
    },
  };
}

describe('MCP Apps UI 握手契约', () => {
  /**
   * 核心回归用例。
   * 业务影响：断言失败 = 该页面在 Claude App 中永久 visibility:hidden，用户什么都看不到。
   */
  it.each(UI_PAGES)('%s 发出 ui/initialize 请求，并在收到响应后发出 ui/notifications/initialized', file => {
    const { posted, dispatch } = runUiScript(file);

    const init = posted.find(m => m.method === 'ui/initialize');
    expect(init, `${file} 必须主动发送 ui/initialize 请求`).toBeDefined();
    // 必须是 request（带 id），否则宿主无法回响应
    expect(init!.id, `${file} 的 ui/initialize 必须带 id（是 request 而非 notification）`).toBeDefined();

    // 宿主回响应：JSON-RPC 响应只有 id + result，没有 method
    dispatch({ jsonrpc: '2.0', id: init!.id, result: { hostInfo: { name: 'test-host', version: '1.0' } } });

    const done = posted.find(m => m.method === 'ui/notifications/initialized');
    expect(
      done,
      `${file} 收到 ui/initialize 响应后必须发出 ui/notifications/initialized；` +
      `缺失会导致 Claude 一直不解除 iframe 外层的 visibility:hidden`
    ).toBeDefined();
    // 通知不能带 id
    expect(done!.id).toBeUndefined();
  });

  /**
   * 业务影响：断言失败 = 页面在非 iframe 环境（浏览器直开、或宿主未用 iframe 承载）
   * 会向自身 postMessage，产生无意义消息甚至异常。
   */
  it.each(UI_PAGES)('%s 在非 iframe 环境（window.parent === window）不启用协议', file => {
    const { posted } = runUiScript(file, false);
    const protocolMsgs = posted.filter(m => typeof m.method === 'string' && m.method.startsWith('ui/'));
    expect(protocolMsgs, `${file} 非 iframe 环境不应发出 ui/* 协议消息`).toEqual([]);
  });
});
