declare module "models" {
  export type CashmaticState = {
    status: string;
    amountInserted: number;
    lastDeviceError: string | null;
    activeTransaction: Record<string, unknown> | null;
    inventory: Array<{
      value: number;
      amount: number;
      status: string;
      type?: string;
      routing?: string;
      currency?: string;
    }>;
  };

  export type CashmaticDirectOptions = {
    paymentTimeout?: number;
    pollingInterval?: number;
  };
}
