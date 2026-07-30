import { correlationId, safeDiagnostic } from "../observability.server.ts";
import { getZakekePublicConfiguration } from "./zakeke-config.server.ts";
import { ZakekeAuthService } from "./zakeke-auth.server.ts";
import {
  ZakekeError,
  zakekeErrorCode,
} from "./zakeke-errors.server.ts";
import type {
  ZakekeAccessType,
  ZakekeIdentity,
} from "./zakeke-types.ts";

type Fetch = typeof fetch;

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  accessType?: ZakekeAccessType;
  identity?: ZakekeIdentity;
  retryable?: boolean;
  operation: string;
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class ZakekeClient {
  private readonly auth: ZakekeAuthService;
  private readonly request: Fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    auth = new ZakekeAuthService(),
    request: Fetch = fetch,
    wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 12_000,
  ) {
    this.auth = auth;
    this.request = request;
    this.wait = wait;
    this.timeoutMs = timeoutMs;
  }

  async requestJson<T>(
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    const accessType = options.accessType ?? "S2S";
    const identity = options.identity ?? {};
    let refreshed = false;
    let forceTokenRefresh = false;
    let retryAttempt = 0;
    for (let requestAttempt = 0; requestAttempt < 4; requestAttempt += 1) {
      const referenceId = correlationId();
      const token =
        accessType === "C2S"
          ? await this.auth.getC2SToken(identity, forceTokenRefresh)
          : await this.auth.getS2SToken(identity, forceTokenRefresh);
      forceTokenRefresh = false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const baseUrl = getZakekePublicConfiguration().apiBaseUrl;
        const response = await this.request(`${baseUrl}${path}`, {
          method: options.method ?? "GET",
          headers: {
            Accept: "application/json",
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            Authorization: `Bearer ${token.accessToken}`,
            "X-Correlation-Id": referenceId,
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: controller.signal,
        });
        if (response.status === 401 && !refreshed) {
          this.auth.invalidate(accessType, identity);
          refreshed = true;
          forceTokenRefresh = true;
          continue;
        }
        if (
          options.retryable &&
          RETRYABLE_STATUSES.has(response.status) &&
          retryAttempt < 2
        ) {
          retryAttempt += 1;
          await this.wait(200 * 2 ** (retryAttempt - 1));
          continue;
        }
        if (!response.ok) {
          throw new ZakekeError({
            code: zakekeErrorCode(response.status, options.operation),
            referenceId,
            status: response.status === 404 ? 404 : 502,
            retryable: RETRYABLE_STATUSES.has(response.status),
          });
        }
        const value = (await response.json().catch(() => null)) as T | null;
        if (value === null) {
          throw new ZakekeError({
            code: "ZAKEKE_UNAVAILABLE",
            referenceId,
            retryable: true,
          });
        }
        return value;
      } catch (error) {
        if (error instanceof ZakekeError) throw error;
        safeDiagnostic("zakeke_request", "failed", {
          correlationId: referenceId,
          operation: options.operation,
        });
        throw new ZakekeError({
          code: "ZAKEKE_UNAVAILABLE",
          referenceId,
          retryable: true,
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ZakekeError({
      code: "ZAKEKE_UNAVAILABLE",
      referenceId: correlationId(),
      retryable: true,
    });
  }
}
