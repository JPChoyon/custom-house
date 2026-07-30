import { ZakekeClient } from "./zakeke-client.server.ts";
import type {
  RegisterZakekeOrderInput,
  RegisterZakekeOrderResult,
  ZakekeIdentity,
} from "./zakeke-types.ts";

export class ZakekeOrderService {
  private readonly client: ZakekeClient;

  constructor(client = new ZakekeClient()) {
    this.client = client;
  }

  registerOrder(
    input: RegisterZakekeOrderInput,
    identity: ZakekeIdentity = {},
  ) {
    return this.client.requestJson<RegisterZakekeOrderResult>("/v2/order", {
      method: "POST",
      body: input,
      operation: "order_register",
      identity,
      retryable: false,
    });
  }
}
