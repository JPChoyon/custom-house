export interface GraphqlResponse<T> { data?: T; errors?: Array<{ message: string }> }
export interface ShopifyGraphqlClient { request<T>(query: string, variables?: Record<string, unknown>): Promise<T> }
type AdminClient = { graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response> };

export class AdminGraphqlClient implements ShopifyGraphqlClient {
  constructor(private readonly admin: AdminClient) {}
  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const document = query.replace(/^#graphql\s+/, "");
    const response = await this.admin.graphql(document, { variables });
    const body = await response.json() as GraphqlResponse<T>;
    if (!response.ok || body.errors?.length || !body.data) throw new Error("Shopify Admin API request failed.");
    return body.data;
  }
}

export function throwUserErrors(errors: Array<{ message: string }> | undefined, operation: string): void {
  if (errors?.length) throw new Error(`${operation} failed: ${errors.map((error) => error.message).join("; ").slice(0, 500)}`);
}
