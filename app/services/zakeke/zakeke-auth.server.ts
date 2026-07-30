import type {
  ZakekeAccessType,
  ZakekeIdentity,
  ZakekeToken,
} from "./zakeke-types.ts";
import { requireZakekeCredentials } from "./zakeke-config.server.ts";
import { ZakekeError } from "./zakeke-errors.server.ts";
import { correlationId, safeDiagnostic } from "../observability.server.ts";

type Fetch = typeof fetch;

type CachedToken = ZakekeToken & { cacheKey: string };

const tokenCache = new Map<string, CachedToken>();

function cacheKey(accessType: ZakekeAccessType, identity: ZakekeIdentity) {
  return [
    accessType,
    identity.customerCode || "",
    identity.visitorCode || "",
  ].join(":");
}

function accessToken(body: Record<string, unknown>) {
  const value = body.access_token ?? body["access-token"];
  return typeof value === "string" ? value : "";
}

export class ZakekeAuthService {
  private readonly request: Fetch;

  constructor(request: Fetch = fetch) {
    this.request = request;
  }

  invalidate(accessType: ZakekeAccessType, identity: ZakekeIdentity = {}) {
    tokenCache.delete(cacheKey(accessType, identity));
  }

  private async getToken(
    accessType: ZakekeAccessType,
    identity: ZakekeIdentity = {},
    forceRefresh = false,
  ): Promise<ZakekeToken> {
    const key = cacheKey(accessType, identity);
    const cached = tokenCache.get(key);
    const now = Math.floor(Date.now() / 1000);
    if (!forceRefresh && cached && cached.expiresAt > now + 60) {
      return cached;
    }
    const referenceId = correlationId();
    const config = requireZakekeCredentials();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      access_type: accessType,
    });
    if (identity.customerCode) {
      body.set("customercode", identity.customerCode);
    }
    if (identity.visitorCode) {
      body.set("visitorcode", identity.visitorCode);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.request(`${config.apiBaseUrl}/token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${config.clientId}:${config.clientSecret}`,
          ).toString("base64")}`,
          "X-Correlation-Id": referenceId,
        },
        body,
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const tokenValue = accessToken(payload);
      const expiresIn = Number(payload.expires_in);
      if (!response.ok || !tokenValue || !Number.isFinite(expiresIn)) {
        throw new ZakekeError({
          code:
            response.status === 401 || response.status === 403
              ? "ZAKEKE_UNAUTHORIZED"
              : "ZAKEKE_UNAVAILABLE",
          referenceId,
          status:
            response.status === 401 || response.status === 403 ? 503 : 502,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const token: CachedToken = {
        accessToken: tokenValue,
        tokenType: "Bearer",
        accessType,
        expiresAt: now + Math.max(1, expiresIn),
        cacheKey: key,
      };
      tokenCache.set(key, token);
      return token;
    } catch (error) {
      if (error instanceof ZakekeError) throw error;
      safeDiagnostic("zakeke_request", "failed", {
        correlationId: referenceId,
        operation: "oauth_token",
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

  getC2SToken(identity: ZakekeIdentity = {}, forceRefresh = false) {
    return this.getToken("C2S", identity, forceRefresh);
  }

  getS2SToken(identity: ZakekeIdentity = {}, forceRefresh = false) {
    return this.getToken("S2S", identity, forceRefresh);
  }
}
