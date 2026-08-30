/**
 * @fileoverview Canonical payment-receipt regression tests for CJ order flows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth/session', () => ({
  ensureAccessToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/config/env', () => ({
  getEnvConfig: () => ({
    webBase: 'https://cjdropshipping.example',
  }),
}));

vi.mock('../../src/mcp-server/resources/index', () => ({
  setOrderListCache: vi.fn(),
  getOrderListCache: vi.fn(),
  setOrderDetailCache: vi.fn(),
  getOrderDetailCache: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('../../src/api-client/http-client', () => ({
  httpClient: { request: (...args: unknown[]) => mockRequest(...args) },
  AuthExpiredError: class extends Error { name = 'AuthExpiredError'; },
  isApiSuccess: (response: { result?: boolean; success?: boolean; code?: number }) =>
    response.result === true || response.success === true || response.code === 200 || response.code === 0,
}));

import { handleOrderTool } from '../../src/mcp-server/tools/order.tool';

const apiSuccess = (data: Record<string, unknown> = {}) => ({
  code: 200,
  result: true,
  message: 'Success',
  data,
});

const parentFinance = (overrides: Record<string, unknown> = {}) => ({
  payId: 'PAY/123',
  successOrders: ['CJ-CHILD-1', 'CJ-CHILD-2'],
  paymentInformation: {
    actualPayment: '13.20',
    orderProductAmount: '10.10',
    commodityTotalAmount: '10.10',
    freight: '2.20',
    iossTaxes: '1.10',
    iossTaxHandlingFee: '0.30',
    serviceFee: '0.20',
    iossAmount: '1.40',
  },
  ignoredPii: { recipient: 'must-not-leak', phone: '+1-secret' },
  ...overrides,
});

const expectedReceipt = {
  product: '10.10',
  freight: '2.20',
  tax_ioss: '1.10',
  handling_other: '0.50',
  discount: '0.70',
  total: '13.20',
  currency: 'USD',
  parent_code: 'CJ-SHIP-1',
  child_codes: ['CJ-CHILD-1', 'CJ-CHILD-2'],
  shipment_id: 'CJ-SHIP-1',
  payment_reference: 'CJ-SHIP-1',
  pay_id: 'PAY/123',
  hosted_url: 'https://cjdropshipping.example/mine/payment?pid=PAY%2F123',
};

const childDetail = (overrides: Record<string, unknown> = {}) => ({
  orderStatus: 'CREATED',
  cjOrderId: 'ORDER-1',
  cjOrderCode: 'DP2608301601170640100',
  ...overrides,
});
const expectedSingleReceipt = {
  ...expectedReceipt,
  child_codes: ['DP2608301601170640100'],
};

function expectCanonicalReceipt(
  result: Awaited<ReturnType<typeof handleOrderTool>>,
  expected: Record<string, unknown> = expectedReceipt
) {
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toEqual({ payment_receipt: expected });
  const text = String(result.content[0].text);
  expect(text.split('\n').at(-1)).toBe(`PAYMENT_RECEIPT_JSON: ${JSON.stringify(expected)}`);
  expect(JSON.stringify(result)).not.toContain('must-not-leak');
  expect(JSON.stringify(result)).not.toContain('+1-secret');
}

describe('canonical order payment receipts', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('returns a canonical parent receipt from generate_payment_link', async () => {
    mockRequest.mockResolvedValueOnce(apiSuccess(parentFinance()));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expectCanonicalReceipt(result);
    expect(result.content[0].text).toContain(expectedReceipt.hosted_url);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['null', null],
  ])('recovers %s successOrders from the exact unpaid parent detail', async (_label, successOrders) => {
    const finance: Record<string, unknown> = parentFinance({ successOrders });
    if (successOrders === undefined) delete finance.successOrders;
    mockRequest
      .mockResolvedValueOnce(apiSuccess(finance))
      .mockResolvedValueOnce(apiSuccess({
        orderStatus: 'UNPAID',
        cjOrderId: 'CJ-SHIP-1',
        cjOrderCode: 'DP2608251211540655100',
      }));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expectCanonicalReceipt(result, {
      ...expectedReceipt,
      child_codes: ['DP2608251211540655100'],
    });
    expect(mockRequest).toHaveBeenNthCalledWith(2, '/shopping/order/getOrderDetail', {
      method: 'GET',
      params: { orderId: 'CJ-SHIP-1' },
      tier: 'read',
    });
  });

  it('fails closed when the parent detail read returns an API failure', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: [] })))
      .mockResolvedValueOnce({ code: 500, result: false, message: 'detail unavailable' });

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('getOrderDetail');
    expect(result.content[0].text).toContain('detail unavailable');
  });

  it('fails closed when the parent detail read throws', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: [] })))
      .mockRejectedValueOnce(new Error('network unavailable'));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('getOrderDetail read failed');
    expect(result.content[0].text).toContain('network unavailable');
  });

  it.each([
    ['not an object', null, 'object'],
    ['an array', [{ orderStatus: 'UNPAID', cjOrderId: 'CJ-SHIP-1', cjOrderCode: 'DP1' }], 'object'],
    ['not UNPAID', { orderStatus: 'PAID', cjOrderId: 'CJ-SHIP-1', cjOrderCode: 'DP1' }, 'UNPAID'],
    ['a different parent', { orderStatus: 'UNPAID', cjOrderId: 'CJ-OTHER', cjOrderCode: 'DP1' }, 'cjOrderId'],
    ['a missing child code', { orderStatus: 'UNPAID', cjOrderId: 'CJ-SHIP-1' }, 'cjOrderCode'],
    ['an invalid child prefix', { orderStatus: 'UNPAID', cjOrderId: 'CJ-SHIP-1', cjOrderCode: 'CJ-CHILD-1' }, 'DP or SD'],
    ['an ambiguous child code', { orderStatus: 'UNPAID', cjOrderId: 'CJ-SHIP-1', cjOrderCode: ['DP1', 'SD1'] }, 'cjOrderCode'],
  ])('fails closed when the parent detail has %s', async (_label, detail, expectedError) => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: [] })))
      .mockResolvedValueOnce(apiSuccess(detail as Record<string, unknown>));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain(expectedError);
  });

  it('never substitutes orderNum, platformOrderId, or lineItemId for cjOrderCode', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: [] })))
      .mockResolvedValueOnce(apiSuccess({
        orderStatus: 'UNPAID',
        cjOrderId: 'CJ-SHIP-1',
        orderNum: 'DP-ORDER-NUM',
        platformOrderId: 'DP-PLATFORM',
        lineItemId: 'SD-LINE-ITEM',
      }));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('cjOrderCode');
  });

  it('returns the same canonical receipt from confirm_cart_and_pay', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: ['DP2608301601170640100'] })));

    const result = await handleOrderTool('confirm_cart_and_pay', { orderId: 'ORDER-1' });

    expectCanonicalReceipt(result, expectedSingleReceipt);
  });

  it('returns the same canonical receipt from submit_order_to_cart', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess())
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: ['DP2608301601170640100'] })));

    const result = await handleOrderTool('submit_order_to_cart', { orderId: 'ORDER-1' });

    expectCanonicalReceipt(result, expectedSingleReceipt);
  });

  it('returns parent and documented payType-3 child finance from create_order', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess({
        orderId: 'ORDER-1',
        iossAmount: '1.40',
        iossTaxHandlingFee: '0.30',
        productAmount: '10.10',
        postageAmount: '2.20',
        actualPayment: '13.20',
      }))
      .mockResolvedValueOnce(apiSuccess())
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: ['DP2608301601170640100'] })));

    const result = await handleOrderTool('create_order', {
      orderInfo: { orderNumber: 'STORE-1', payType: 3 },
    });

    expectCanonicalReceipt(result, {
      ...expectedSingleReceipt,
      child_financial_receipt: {
        ioss_amount: '1.40',
        ioss_tax_handling_fee: '0.30',
        product_amount: '10.10',
        postage_amount: '2.20',
        actual_payment: '13.20',
        currency: 'USD',
      },
    });
  });

  it('rejects a successful payment response with missing finance', async () => {
    mockRequest.mockResolvedValueOnce(apiSuccess({
      payId: 'PAY-1',
      successOrders: ['CJ-CHILD-1'],
    }));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('paymentInformation');
  });

  it('rejects exact duplicate child order codes', async () => {
    mockRequest.mockResolvedValueOnce(apiSuccess(parentFinance({
      successOrders: ['CJ-CHILD-1', 'CJ-CHILD-1'],
    })));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('duplicate child order codes');
  });

  it('rejects malformed decimal finance instead of coercing it', async () => {
    const malformed = parentFinance();
    (malformed.paymentInformation as Record<string, unknown>).actualPayment = '13.2oops';
    mockRequest.mockResolvedValueOnce(apiSuccess(malformed));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('actualPayment');
  });

  it('rejects non-reconciling finance instead of inventing a negative discount', async () => {
    const nonReconciling = parentFinance();
    (nonReconciling.paymentInformation as Record<string, unknown>).actualPayment = '14.00';
    mockRequest.mockResolvedValueOnce(apiSuccess(nonReconciling));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('reconcile');
  });

  it('derives discount with exact decimal arithmetic', async () => {
    mockRequest.mockResolvedValueOnce(apiSuccess(parentFinance({
      successOrders: ['CJ-CHILD-1'],
      paymentInformation: {
        actualPayment: '0.85',
        orderProductAmount: '0.10',
        freight: '0.20',
        iossTaxes: '0.30',
        iossTaxHandlingFee: '0.10',
        serviceFee: '0.20',
        iossAmount: '0.40',
      },
    })));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.payment_receipt).toMatchObject({
      handling_other: '0.30',
      discount: '0.05',
      total: '0.85',
    });
  });

  it('uses orderProductAmount when commodityTotalAmount represents the payable total', async () => {
    mockRequest.mockResolvedValueOnce(apiSuccess(parentFinance({
      paymentInformation: {
        actualPayment: '13.20',
        orderProductAmount: '10.10',
        commodityTotalAmount: '13.20',
        freight: '2.20',
        iossTaxes: '1.10',
        iossTaxHandlingFee: '0.30',
        serviceFee: '0.20',
        iossAmount: '1.40',
      },
    })));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expectCanonicalReceipt(result);
  });

  it('accepts orderProductAmount when commodityTotalAmount is absent', async () => {
    const fallbackFinance = parentFinance();
    delete (fallbackFinance.paymentInformation as Record<string, unknown>).commodityTotalAmount;
    mockRequest.mockResolvedValueOnce(apiSuccess(fallbackFinance));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expectCanonicalReceipt(result);
  });

  it('does not reinterpret commodityTotalAmount as the product amount', async () => {
    const invalidCommodity = parentFinance();
    (invalidCommodity.paymentInformation as Record<string, unknown>).commodityTotalAmount = 'invalid';
    mockRequest.mockResolvedValueOnce(apiSuccess(invalidCommodity));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expectCanonicalReceipt(result);
  });

  it('fails closed when orderProductAmount is absent', async () => {
    const missingProduct = parentFinance();
    delete (missingProduct.paymentInformation as Record<string, unknown>).orderProductAmount;
    mockRequest.mockResolvedValueOnce(apiSuccess(missingProduct));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('orderProductAmount');
  });

  it('cross-checks iossAmount only as tax plus IOSS handling', async () => {
    const inconsistentIoss = parentFinance();
    (inconsistentIoss.paymentInformation as Record<string, unknown>).iossAmount = '1.41';
    mockRequest.mockResolvedValueOnce(apiSuccess(inconsistentIoss));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('iossAmount');
  });

  it('keeps the authoritative parent receipt when optional payType-3 child finance is partial', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess({ orderId: 'ORDER-1', productAmount: '10.10' }))
      .mockResolvedValueOnce(apiSuccess())
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: ['DP2608301601170640100'] })));

    const result = await handleOrderTool('create_order', {
      orderInfo: { orderNumber: 'STORE-1', payType: 3 },
    });

    expectCanonicalReceipt(result, expectedSingleReceipt);
    expect(result.structuredContent?.payment_receipt).not.toHaveProperty('child_financial_receipt');
  });

  it('uses the exact child code when successful addCartConfirm returns an empty shipmentsId', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess())
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: '' }))
      .mockResolvedValueOnce(apiSuccess(childDetail()))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: [] })));

    const result = await handleOrderTool('submit_order_to_cart', { orderId: 'DP2608301601170640100' });

    expectCanonicalReceipt(result, {
      ...expectedReceipt,
      parent_code: 'DP2608301601170640100',
      child_codes: ['DP2608301601170640100'],
      shipment_id: 'DP2608301601170640100',
      payment_reference: 'DP2608301601170640100',
    });
    expect(mockRequest).toHaveBeenNthCalledWith(5, '/shopping/order/saveGenerateParentOrder', {
      body: { shipmentOrderId: 'DP2608301601170640100' },
      tier: 'write',
    });
  });

  it('resumes an already UNPAID child without replaying addCart or addCartConfirm', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(childDetail({
        orderStatus: 'UNPAID',
        cjOrderCode: 'DP2608301601170640100',
      })))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: [] })));

    const result = await handleOrderTool('submit_order_to_cart', { orderId: 'DP2608301601170640100' });

    expectCanonicalReceipt(result, {
      ...expectedReceipt,
      parent_code: 'DP2608301601170640100',
      child_codes: ['DP2608301601170640100'],
      shipment_id: 'DP2608301601170640100',
      payment_reference: 'DP2608301601170640100',
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest).toHaveBeenNthCalledWith(2, '/shopping/order/saveGenerateParentOrder', {
      body: { shipmentOrderId: 'DP2608301601170640100' },
      tier: 'write',
    });
  });

  it('fails closed when a single-order parent receipt names a different child', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess(childDetail({ orderStatus: 'UNPAID' })))
      .mockResolvedValueOnce(apiSuccess(parentFinance({ successOrders: ['DP9999999999999999999'] })));

    const result = await handleOrderTool('submit_order_to_cart', { orderId: 'DP2608301601170640100' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('child scope');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});
