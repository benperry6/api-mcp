/**
 * @fileoverview Targeted tests for CJ makeup/supplement payment tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth/session', () => ({
  ensureAccessToken: vi.fn().mockResolvedValue('mock-token'),
}));

const mockRequest = vi.fn();
vi.mock('../../src/api-client/http-client', () => ({
  httpClient: { request: (...args: unknown[]) => mockRequest(...args) },
  AuthExpiredError: class extends Error { name = 'AuthExpiredError'; },
  isApiSuccess: (response: { result?: boolean; success?: boolean; code?: number }) =>
    response.result === true || response.success === true || response.code === 200 || response.code === 0,
}));

vi.mock('../../src/config/env', () => ({
  getEnvConfig: () => ({
    openApiBase: 'https://developers.cjdropshipping.com',
    webBase: 'https://www.cjdropshipping.com',
  }),
}));

vi.mock('../../src/mcp-server/resources/index', () => ({
  setOrderListCache: vi.fn(),
  setOrderDetailCache: vi.fn(),
  getOrderListCache: vi.fn(),
  getOrderDetailCache: vi.fn(),
}));

import { getOrderTools, handleOrderTool, orderTools } from '../../src/mcp-server/tools/order.tool';
import { isSensitiveTool } from '../../src/utils/sensitive-ops';

describe('CJ makeup tools', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockResolvedValue({ code: 200, result: true, message: 'Success', data: {} });
  });

  it('registers exact list and payment-order tools with the correct safety annotations', () => {
    const names = orderTools.map(tool => tool.name);
    expect(names).toContain('list_makeup_orders');
    expect(names).toContain('create_makeup_payment_order');

    const listed = getOrderTools();
    expect(listed.find(tool => tool.name === 'list_makeup_orders')?.annotations).toEqual({ readOnlyHint: true });
    expect(listed.find(tool => tool.name === 'create_makeup_payment_order')?.annotations).toBeUndefined();
    expect(isSensitiveTool('create_makeup_payment_order')).toBe(true);
  });

  it('posts bounded list filters to the official makeup list endpoint as a read', async () => {
    const data = {
      type: 0,
      totalAmount: 11.19,
      pageData: { content: [{ orderCode: 'BT260820001', cjOrderCode: 'SD260820001', amount: 11.19 }] },
    };
    mockRequest.mockResolvedValueOnce({ code: 200, result: true, message: 'Success', data });

    const result = await handleOrderTool('list_makeup_orders', { pageNum: 2, pageSize: 999, type: 0 });

    expect(mockRequest).toHaveBeenCalledWith('/shopping/makeup/list', {
      method: 'POST',
      body: { pageNum: 2, pageSize: 200, type: 0 },
      tier: 'read',
    });
    expect(JSON.parse(String(result.content[0].text))).toEqual(data);
  });

  it('creates only a payment order for exact frozen BT codes and returns the authoritative CJ response', async () => {
    const data = {
      payOrderCode: '260820000001',
      payId: 'PAY260820000001',
      amount: 11.19,
      cjPayUrl: 'https://www.cjdropshipping.com/mine/payment?pid=PAY260820000001',
      paymentPagePath: '/mine/payment?pid=PAY260820000001',
    };
    mockRequest.mockResolvedValueOnce({ code: 200, result: true, message: 'Success', data });

    const result = await handleOrderTool('create_makeup_payment_order', {
      orderCodes: ['BT260820001'],
      type: 0,
    });

    expect(mockRequest).toHaveBeenCalledWith('/shopping/makeup/createPayOrder', {
      method: 'POST',
      body: { orderCodes: ['BT260820001'], type: 0 },
      tier: 'write',
    });
    expect(JSON.parse(String(result.content[0].text))).toEqual(data);
  });

  it.each([
    [{ orderCodes: [], type: 0 }, 'at least one'],
    [{ orderCodes: ['SD260820001'], type: 0 }, 'BT'],
    [{ orderCodes: ['BT260820001', 'BT260820001'], type: 0 }, 'duplicate'],
    [{ orderCodes: ['BT260820001'], type: 1 }, 'diffUseType'],
    [{ orderCodes: ['BT260820001'], type: 1, diffUseType: 0 }, 'diffUseType'],
  ])('blocks malformed or ambiguous createPayOrder input: %j', async (args, message) => {
    const result = await handleOrderTool('create_makeup_payment_order', args);

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain(message);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('preserves official API error code 9055 without creating a fallback route', async () => {
    mockRequest.mockResolvedValueOnce({
      code: 9055,
      result: false,
      message: 'Order dispute in progress. You cannot make payment now.',
      data: null,
    });

    const result = await handleOrderTool('create_makeup_payment_order', {
      orderCodes: ['BT260820870'],
      type: 0,
    });

    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toContain('9055');
    expect(String(result.content[0].text)).toContain('Order dispute in progress');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
