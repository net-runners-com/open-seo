import { env } from "cloudflare:workers";
import { getAuth } from "@/lib/auth";
import { API_KEY_PREFIX } from "@/lib/auth-api-key";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import {
  RunnerJobService,
  type RunnerAuthScope,
} from "@/server/features/rank-tracking/services/RunnerJobService";
import {
  heartbeatRequestSchema,
  submitResultsRequestSchema,
} from "@/types/schemas/runner";

export const RUNNER_ROUTE_PREFIX = "/api/runner";

const DEFAULT_CLAIM_LIMIT = 10;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, description: string) {
  return jsonResponse({ error: code, error_description: description }, status);
}

// Constant-time comparison so RUNNER_TOKEN can't be probed byte by byte.
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function resolveScope(request: Request): Promise<RunnerAuthScope | null> {
  const token = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /i, "")
    .trim();
  if (!token) return null;

  if (token.startsWith(API_KEY_PREFIX)) {
    // Same verification path as /mcp: verifyApiKey never becomes a session,
    // so a runner key can't reach account or organization endpoints.
    const result = await getAuth().api.verifyApiKey({ body: { key: token } });
    if (!result.valid || !result.key) return null;
    const organizationIds = await AuthRepository.getOrganizationIdsForUser(
      result.key.referenceId,
    );
    if (organizationIds.length === 0) return null;
    return { organizationIds };
  }

  // Self-host: a fixed token from the environment. Absent config fails closed.
  const runnerToken = (env as { RUNNER_TOKEN?: string }).RUNNER_TOKEN;
  if (runnerToken && timingSafeEqual(token, runnerToken)) {
    return { organizationIds: null };
  }
  return null;
}

export async function handleRunnerRequest(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== RUNNER_ROUTE_PREFIX &&
    !url.pathname.startsWith(`${RUNNER_ROUTE_PREFIX}/`)
  ) {
    return null;
  }

  let scope: RunnerAuthScope | null;
  try {
    scope = await resolveScope(request);
  } catch (error) {
    console.error("[runner-api] 500 (auth):", error);
    return errorResponse(500, "internal_error", "Runner authentication failed");
  }
  if (!scope) {
    // Bad credentials are client-side noise (mirrors the /mcp API key path).
    console.debug(`[runner-api] 401 ${url.pathname}`);
    return errorResponse(
      401,
      "unauthorized",
      "A valid API key or runner token is required",
    );
  }

  const route = url.pathname.slice(RUNNER_ROUTE_PREFIX.length);
  try {
    if (route === "/jobs") {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "Use GET");
      }
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0
        ? limitParam
        : DEFAULT_CLAIM_LIMIT;
      const jobs = await RunnerJobService.claimJobs(scope, limit);
      return jsonResponse({ jobs });
    }

    if (route === "/results") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "Use POST");
      }
      const parsed = submitResultsRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return errorResponse(400, "invalid_payload", parsed.error.message);
      }
      const outcome = await RunnerJobService.submitResults(
        scope,
        parsed.data.results,
      );
      return jsonResponse(outcome);
    }

    if (route === "/heartbeat") {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "Use POST");
      }
      const parsed = heartbeatRequestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return errorResponse(400, "invalid_payload", parsed.error.message);
      }
      await RunnerJobService.recordHeartbeat(scope, parsed.data.status);
      return new Response(null, { status: 204 });
    }

    return errorResponse(404, "not_found", "Unknown runner endpoint");
  } catch (error) {
    console.error("[runner-api] 500 (internal):", error);
    return errorResponse(500, "internal_error", "Runner request failed");
  }
}
