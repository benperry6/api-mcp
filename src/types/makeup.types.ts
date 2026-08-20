/** CJ makeup/supplement payment API contracts. */

export type MakeupType = 0 | 1;
export type MakeupDiffUseType = 0 | 1 | 2 | 3;

export interface MakeupListRequest extends Record<string, unknown> {
  pageNum: number;
  pageSize: number;
  type?: MakeupType;
  diffUseType?: MakeupDiffUseType;
}

export interface MakeupBill {
  orderCode: string;
  cjOrderCode: string;
  status: number;
  amount: number;
  reason: string;
  orderType: number;
  diffUseType: MakeupDiffUseType;
  createAt: number;
}

export interface MakeupListResponse {
  type: MakeupType;
  totalAmount: number;
  unPaymentCountList: Array<{ type: MakeupType; count: number }>;
  pageData: {
    pageSize: number;
    pageNumber: number;
    totalRecords: number;
    totalPages: number;
    content: MakeupBill[];
  };
}

export interface CreateMakeupPaymentOrderRequest extends Record<string, unknown> {
  orderCodes: string[];
  type: MakeupType;
  diffUseType?: MakeupDiffUseType;
}

export interface CreateMakeupPaymentOrderResponse {
  payOrderCode: string;
  payId: string;
  amount: number;
  cjPayUrl: string;
  paymentPagePath: string;
}