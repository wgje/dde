import { NodeSDK } from "npm:@opentelemetry/sdk-node@0.221.0";
import { LangfuseSpanProcessor } from "npm:@langfuse/otel@5.10.0";
import {
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from "npm:@langfuse/tracing@5.10.0";

const LANGFUSE_PUBLIC_KEY = Deno.env.get("LANGFUSE_PUBLIC_KEY")?.trim();
const LANGFUSE_SECRET_KEY = Deno.env.get("LANGFUSE_SECRET_KEY")?.trim();
const LANGFUSE_BASE_URL = Deno.env.get("LANGFUSE_BASE_URL")?.trim() ||
  "https://cloud.langfuse.com";
const LANGFUSE_ENVIRONMENT =
  Deno.env.get("LANGFUSE_TRACING_ENVIRONMENT")?.trim() || "production";
const LANGFUSE_DISABLED = Deno.env.get("LANGFUSE_ENABLED") === "false";

export const langfuseEnabled = Boolean(
  !LANGFUSE_DISABLED && LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY,
);

/**
 * Edge Functions are short-lived. Immediate export plus an explicit flush
 * prevents the worker from being reclaimed before the trace is uploaded.
 */
export const langfuseSpanProcessor = langfuseEnabled
  ? new LangfuseSpanProcessor({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_BASE_URL,
    environment: LANGFUSE_ENVIRONMENT,
    exportMode: "immediate",
  })
  : null;

if (langfuseSpanProcessor) {
  const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
  sdk.start();
}

export interface GroqTranscriptionTraceInput {
  userId: string;
  fileSizeBytes: number;
  mimeType: string;
  fileExtension: string;
  model: string;
  language: string;
}

function safeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 200),
    };
  }
  return { name: "UnknownError", message: "Unknown transcription error" };
}

async function summarizeGroqResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {
    status: response.ok ? "ok" : "error",
    httpStatus: response.status,
  };

  // Inspect a clone only to capture safe metrics. The transcript itself is
  // intentionally never placed in Langfuse because it may contain PII.
  if (response.ok) {
    try {
      const data = await response.clone().json() as Record<string, unknown>;
      if (typeof data.text === "string") {
        summary.transcriptChars = data.text.length;
      }
      if (typeof data.duration === "number") {
        summary.durationSeconds = data.duration;
      }
      if (typeof data.language === "string") summary.language = data.language;
    } catch {
      summary.responseBody = "redacted";
    }
  }

  return summary;
}

/**
 * Trace one Groq transcription request without capturing audio, transcript
 * content, authorization headers, or upstream error bodies.
 */
export async function traceGroqTranscription(
  input: GroqTranscriptionTraceInput,
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  if (!langfuseSpanProcessor) {
    return fetch(endpoint, init);
  }

  const startedAt = Date.now();

  try {
    return await startActiveObservation("speech-to-text", async (rootSpan) => {
      rootSpan.update({
        input: {
          fileSizeBytes: input.fileSizeBytes,
          mimeType: input.mimeType,
          fileExtension: input.fileExtension,
          model: input.model,
          language: input.language,
          contentCapture: "redacted",
        },
      });

      return await propagateAttributes(
        {
          userId: input.userId,
          tags: ["speech-to-text", "groq", "whisper"],
          metadata: {
            provider: "groq",
            model: input.model,
            contentCapture: "redacted",
          },
          traceName: "speech-to-text",
        },
        async () => {
          const generation = startObservation(
            "groq-whisper-transcription",
            {
              model: input.model,
              input: {
                audio: {
                  fileSizeBytes: input.fileSizeBytes,
                  mimeType: input.mimeType,
                  fileExtension: input.fileExtension,
                },
                language: input.language,
              },
            },
            { asType: "generation" },
          );

          try {
            const response = await fetch(endpoint, init);
            const responseSummary = await summarizeGroqResponse(response);
            const latencyMs = Date.now() - startedAt;
            generation.update({
              output: { ...responseSummary, latencyMs },
            });
            rootSpan.update({
              output: { ...responseSummary, latencyMs },
            });
            return response;
          } catch (error) {
            const errorSummary = safeError(error);
            const latencyMs = Date.now() - startedAt;
            generation.update({
              output: { status: "error", error: errorSummary, latencyMs },
            });
            rootSpan.update({
              output: { status: "error", error: errorSummary, latencyMs },
            });
            throw error;
          } finally {
            generation.end();
          }
        },
      );
    });
  } finally {
    try {
      await langfuseSpanProcessor.forceFlush();
    } catch (error) {
      // Observability must never change transcription behavior.
      console.warn(
        "[Langfuse] Failed to flush transcription trace:",
        safeError(error).name,
      );
    }
  }
}
