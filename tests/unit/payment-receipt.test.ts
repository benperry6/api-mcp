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
  });

  it('returns the same canonical receipt from confirm_cart_and_pay', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(parentFinance()));

    const result = await handleOrderTool('confirm_cart_and_pay', { orderId: 'ORDER-1' });

    expectCanonicalReceipt(result);
  });

  it('returns the same canonical receipt from submit_order_to_cart', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess())
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(parentFinance()));

    const result = await handleOrderTool('submit_order_to_cart', { orderId: 'ORDER-1' });

    expectCanonicalReceipt(result);
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
      .mockResolvedValueOnce(apiSuccess(parentFinance()));

    const result = await handleOrderTool('create_order', {
      orderInfo: { orderNumber: 'STORE-1', payType: 3 },
    });

    expectCanonicalReceipt(result, {
      ...expectedReceipt,
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

  it('uses commodityTotalAmount when both product amounts are present and disagree', async () => {
    mockRequest.mockResolvedValueOnce(apiSuccess(parentFinance({
      paymentInformation: {
        actualPayment: '13.20',
        orderProductAmount: '99.99',
        commodityTotalAmount: '10.10',
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

  it('falls back to orderProductAmount when commodityTotalAmount is absent', async () => {
    const fallbackFinance = parentFinance();
    delete (fallbackFinance.paymentInformation as Record<string, unknown>).commodityTotalAmount;
    mockRequest.mockResolvedValueOnce(apiSuccess(fallbackFinance));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expectCanonicalReceipt(result);
  });

  it('rejects invalid commodityTotalAmount without falling back to orderProductAmount', async () => {
    const invalidCommodity = parentFinance();
    (invalidCommodity.paymentInformation as Record<string, unknown>).commodityTotalAmount = 'invalid';
    mockRequest.mockResolvedValueOnce(apiSuccess(invalidCommodity));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain('commodityTotalAmount');
  });

  it('cross-checks iossAmount only as tax plus IOSS handling', async () => {
    const inconsistentIoss = parentFinance();
    (inconsistentIoss.paymentInformation as Record<string, unknown>).iossAmount = '1.41';
    mockRequest.mockResolvedValueOnce(apiSuccess(inconsistentIoss));

    const result = await handleOrderTool('generate_payment_link', { shipmentsId: 'CJ-SHIP-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('iossAmount');
  });

  it('rejects partial payType-3 child finance', async () => {
    mockRequest
      .mockResolvedValueOnce(apiSuccess({ orderId: 'ORDER-1', productAmount: '10.10' }))
      .mockResolvedValueOnce(apiSuccess())
      .mockResolvedValueOnce(apiSuccess({ shipmentsId: 'CJ-SHIP-1' }))
      .mockResolvedValueOnce(apiSuccess(parentFinance()));

    const result = await handleOrderTool('create_order', {
      orderInfo: { orderNumber: 'STORE-1', payType: 3 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('child financial receipt');
  });
});
