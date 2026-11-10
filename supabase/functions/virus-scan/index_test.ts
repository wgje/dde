export {};

const DUMMY_SUPABASE_URL = "http://supabase.test";
const DUMMY_CLAMAV_URL = "http://clamav.test";

// Set synthetic values before importing the function, which reads these at module load.
Deno.env.set("CLAMAV_API_URL", DUMMY_CLAMAV_URL);
Deno.env.set("SUPABASE_URL", DUMMY_SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only-not-a-secret");
Deno.env.set("VIRUS_RESCAN_CRON_SECRET", "test-only-cron-placeholder");
Deno.env.set("ALLOWED_ORIGINS", "http://edge.test");
Deno.env.set("ALLOW_PREVIEW_ORIGINS", "false");

let clamAvStatus = 200;
let authRequestCount = 0;
let clamAvRequestCount = 0;
let scanSideEffectCount = 0;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (
  input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, _init);
  const url = new URL(request.url);
  if (url.origin === DUMMY_SUPABASE_URL && url.pathname === "/auth/v1/user") {
    authRequestCount += 1;
    if (
      request.headers.get("Authorization") === "Bearer virus-scan-invalid-token"
    ) {
      return new Response(JSON.stringify({ message: "Invalid JWT" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        aud: "authenticated",
        role: "authenticated",
        email: "virus-scan-test@example.test",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.origin === DUMMY_CLAMAV_URL && url.pathname === "/ping") {
    clamAvRequestCount += 1;
    return new Response("", { status: clamAvStatus });
  }
  scanSideEffectCount += 1;
  throw new Error(`Unexpected test fetch target: ${url.origin}${url.pathname}`);
};

const { handleRequest } = await import("./index.ts");

Deno.test("POST action=health routes through the request handler and returns healthy/degraded shapes", async () => {
  const cases = [
    { clamAvHttpStatus: 200, status: "healthy", clamav: true },
    { clamAvHttpStatus: 503, status: "degraded", clamav: false },
  ] as const;

  try {
    for (const testCase of cases) {
      clamAvStatus = testCase.clamAvHttpStatus;
      const response = await handleRequest(
        new Request("http://edge.test/functions/v1/virus-scan", {
          method: "POST",
          headers: {
            Authorization: "Bearer virus-scan-test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "health" }),
        }),
      );

      if (response.status !== 200) {
        throw new Error(
          `Expected HTTP 200 for ${testCase.status}, got ${response.status}`,
        );
      }
      const body = await response.json() as {
        status?: unknown;
        clamav?: unknown;
        timestamp?: unknown;
      };
      if (body.status !== testCase.status || body.clamav !== testCase.clamav) {
        throw new Error(`Unexpected health response for ${testCase.status}`);
      }
      if (
        typeof body.timestamp !== "string" ||
        Number.isNaN(Date.parse(body.timestamp))
      ) {
        throw new Error(
          "Health response timestamp must be a valid date string",
        );
      }
    }

    if (
      authRequestCount !== cases.length || clamAvRequestCount !== cases.length
    ) {
      throw new Error(
        "Health requests must authenticate and probe ClamAV once per request",
      );
    }

    const missingAuthResponse = await handleRequest(
      new Request("http://edge.test/functions/v1/virus-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health" }),
      }),
    );
    if (missingAuthResponse.status !== 401) {
      throw new Error(
        `Missing Authorization must return 401, got ${missingAuthResponse.status}`,
      );
    }

    const invalidAuthResponse = await handleRequest(
      new Request("http://edge.test/functions/v1/virus-scan", {
        method: "POST",
        headers: {
          Authorization: "Bearer virus-scan-invalid-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "scan",
          file: "dGVzdA==",
          filename: "health-auth-rejection.txt",
          mimeType: "text/plain",
        }),
      }),
    );
    if (invalidAuthResponse.status !== 401) {
      throw new Error(
        `Invalid Authorization must return 401, got ${invalidAuthResponse.status}`,
      );
    }
    if (authRequestCount !== cases.length + 1) {
      throw new Error(
        "Only the invalid-token request should call the auth endpoint",
      );
    }
    if (clamAvRequestCount !== cases.length || scanSideEffectCount !== 0) {
      throw new Error(
        "Unauthorized health/scan requests must not reach ClamAV or other scan side effects",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
