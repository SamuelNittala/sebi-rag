/**
 * Rate limiter module for MCP server usage tracking and limiting.
 *
 * Tracks API usage and enforces rate limits per API key:
 * - Free tier: 10 queries/minute, 100 queries/day, 1000 queries/month
 * - Pro tier: 100 queries/minute, 10000 queries/day, unlimited/month
 */

import { db } from "@mf-rag/db/client";
import { createHash } from "node:crypto";
import {
  apiKeys,
  apiKeyTenantScopes,
  usageRecords,
} from "@mf-rag/db/schema";
import { eq, and, gte, count, sql } from "drizzle-orm";
import type { ApiKey, UsageRecord } from "@mf-rag/db/schema";

/** Rate limit configuration per tier. */
export interface RateLimitConfig {
  /** Queries per minute */
  perMinute: number;
  /** Queries per day */
  perDay: number;
  /** Queries per month (0 = unlimited) */
  perMonth: number;
}

/** Default rate limits by tier. */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  free: {
    perMinute: 10,
    perDay: 100,
    perMonth: 1000,
  },
  pro: {
    perMinute: 100,
    perDay: 10000,
    perMonth: 0, // unlimited
  },
};

/** Result of a rate limit check. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: {
    perMinute: number;
    perDay: number;
    perMonth: number;
  };
  resetAt: {
    perMinute: Date;
    perDay: Date;
    perMonth: Date;
  };
  reason?: string;
}

export interface RateLimitSubject {
  readonly id: string;
  readonly tier: string;
}

/** Error thrown when rate limit is exceeded. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly result: RateLimitResult
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Error thrown when API key is invalid or inactive. */
export class ApiKeyError extends Error {
  constructor(
    message: string,
    public readonly type: "missing" | "invalid" | "inactive"
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

/**
 * Rate limiter class for managing API usage.
 */
export class RateLimiter {
  /**
   * Authenticate a credential and authorize one exact tenant grant.
   * The lookup is intentionally uncached so deactivation and grant removal
   * take effect on the next request.
   */
  async authorize(credential: string, tenantId: string): Promise<
    | { decision: "authorized"; keyId: string; keyTier: string }
    | {
        decision:
          | "invalid_credential"
          | "inactive_credential"
          | "unauthorized_scope";
      }
  > {
    const fingerprint = this.fingerprint(credential);
    const [record] = await db
      .select({
        apiKey: apiKeys,
        grantedTenantId: apiKeyTenantScopes.tenantId,
      })
      .from(apiKeys)
      .leftJoin(
        apiKeyTenantScopes,
        and(
          eq(apiKeyTenantScopes.apiKeyId, apiKeys.id),
          eq(apiKeyTenantScopes.tenantId, tenantId),
        ),
      )
      .where(eq(apiKeys.keyFingerprint, fingerprint))
      .limit(1);

    if (!record) return { decision: "invalid_credential" };
    if (!record.apiKey.isActive) return { decision: "inactive_credential" };
    if (record.grantedTenantId !== tenantId) {
      return { decision: "unauthorized_scope" };
    }
    return {
      decision: "authorized",
      keyId: record.apiKey.id,
      keyTier: record.apiKey.tier,
    };
  }

  /**
   * Validate an API key.
   *
   * @param key - API key string
   * @returns ApiKey record if valid
   * @throws ApiKeyError if key is invalid or inactive
   */
  async validateApiKey(key: string | undefined): Promise<ApiKey> {
    if (!key) {
      throw new ApiKeyError(
        "API key is required. Set MF_RAG_API_KEY in your MCP client configuration.",
        "missing"
      );
    }

    const fingerprint = this.fingerprint(key);
    const [apiKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyFingerprint, fingerprint))
      .limit(1);

    if (!apiKey) {
      throw new ApiKeyError(
        "Invalid API key. Get a key at https://mf-rag.example.com/api-keys",
        "invalid"
      );
    }

    if (!apiKey.isActive) {
      throw new ApiKeyError(
        "API key is inactive. Contact support for assistance.",
        "inactive"
      );
    }

    return apiKey;
  }

  /**
   * Check rate limits for an API key.
   *
   * @param apiKey - Validated API key record
   * @returns RateLimitResult with current limits and remaining quota
   */
  async checkLimits(apiKey: RateLimitSubject): Promise<RateLimitResult> {
    const limits = RATE_LIMITS[apiKey.tier] ?? RATE_LIMITS.free;
    const now = new Date();

    // Calculate time boundaries
    const oneMinuteAgo = new Date(now.getTime() - 60000);
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Query usage counts in parallel
    const [minuteCount, dayCount, monthCount] = await Promise.all([
      this.countUsage(apiKey.id, oneMinuteAgo),
      this.countUsage(apiKey.id, startOfDay),
      this.countUsage(apiKey.id, startOfMonth),
    ]);

    // Calculate remaining
    const remaining = {
      perMinute: Math.max(0, limits.perMinute - minuteCount),
      perDay: Math.max(0, limits.perDay - dayCount),
      perMonth: limits.perMonth === 0 ? Infinity : Math.max(0, limits.perMonth - monthCount),
    };

    // Calculate reset times
    const resetAt = {
      perMinute: new Date(now.getTime() + 60000),
      perDay: new Date(startOfDay.getTime() + 86400000),
      perMonth: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };

    // Check if any limit exceeded
    let allowed = true;
    let reason: string | undefined;

    if (remaining.perMinute === 0) {
      allowed = false;
      reason = `Rate limit exceeded: ${limits.perMinute} queries per minute. Resets in ${Math.ceil((resetAt.perMinute.getTime() - now.getTime()) / 1000)} seconds.`;
    } else if (remaining.perDay === 0) {
      allowed = false;
      reason = `Daily limit exceeded: ${limits.perDay} queries per day. Resets at midnight.`;
    } else if (remaining.perMonth === 0) {
      allowed = false;
      reason = `Monthly limit exceeded: ${limits.perMonth} queries per month. Resets on the 1st.`;
    }

    return { allowed, remaining, resetAt, reason };
  }

  /**
   * Check rate limits and throw if exceeded.
   *
   * @param apiKey - Validated API key record
   * @throws RateLimitError if any limit is exceeded
   */
  async enforceLimit(apiKey: RateLimitSubject): Promise<RateLimitResult> {
    const result = await this.checkLimits(apiKey);

    if (!result.allowed) {
      throw new RateLimitError(result.reason ?? "Rate limit exceeded", result);
    }

    return result;
  }

  /**
   * Record a usage event.
   *
   * @param apiKeyId - API key UUID
   * @param toolName - Name of the tool called
   * @param options - Additional usage metadata
   */
  async recordUsage(
    apiKeyId: string,
    toolName: string,
    options?: {
      queryHash?: string;
      responseTimeMs?: number;
      chunksRetrieved?: number;
      correlationId?: string;
      tenantId?: string;
      operation?: string;
      decision?: string;
      reasonCode?: string;
      resultCount?: number;
    }
  ): Promise<void> {
    await db.insert(usageRecords).values({
      apiKeyId,
      toolName,
      queryHash: options?.queryHash,
      responseTimeMs: options?.responseTimeMs,
      chunksRetrieved: options?.chunksRetrieved,
      correlationId: options?.correlationId,
      tenantId: options?.tenantId,
      operation: options?.operation,
      decision: options?.decision,
      reasonCode: options?.reasonCode,
      resultCount: options?.resultCount,
    });
  }

  /**
   * Count usage records since a given time.
   */
  private async countUsage(apiKeyId: string, since: Date): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.apiKeyId, apiKeyId),
          gte(usageRecords.timestamp, since)
        )
      );

    return result?.count ?? 0;
  }

  /**
   * Get usage statistics for an API key.
   *
   * @param apiKeyId - API key UUID
   * @returns Usage statistics
   */
  async getUsageStats(apiKeyId: string): Promise<{
    today: number;
    thisMonth: number;
    allTime: number;
  }> {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [todayCount, monthCount, allTimeCount] = await Promise.all([
      this.countUsage(apiKeyId, startOfDay),
      this.countUsage(apiKeyId, startOfMonth),
      this.countUsage(apiKeyId, new Date(0)),
    ]);

    return {
      today: todayCount,
      thisMonth: monthCount,
      allTime: allTimeCount,
    };
  }

  /**
   * Generate a new API key.
   *
   * @param options - Key configuration
   * @returns The generated API key string
   */
  async generateKey(options?: {
    tier?: string;
    name?: string;
    email?: string;
  }): Promise<string> {
    // Generate a random key: mf_[tier]_[random]
    const tier = options?.tier ?? "free";
    const randomPart = crypto.randomUUID().replace(/-/g, "");
    const key = `mf_${tier}_${randomPart}`;

    await db.insert(apiKeys).values({
      keyFingerprint: this.fingerprint(key),
      tier,
      name: options?.name,
      email: options?.email,
    });

    return key;
  }

  /**
   * Deactivate an API key.
   *
   * @param key - API key string
   */
  async deactivateKey(key: string): Promise<void> {
    await db
      .update(apiKeys)
      .set({ isActive: false })
      .where(eq(apiKeys.keyFingerprint, this.fingerprint(key)));
  }

  private fingerprint(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }
}

// Export types
export type { ApiKey, UsageRecord };
