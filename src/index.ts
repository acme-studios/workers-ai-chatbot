import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt (kept) + small safety shim
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";
const SAFETY_SHIM =
  "If a user asks for illegal, violent, or harmful instructions, refuse briefly and suggest safer, educational alternatives.";

/**
 * Normalize incoming JSON and be resilient to extra fields
 */
type IncomingBody = {
  messages?: ChatMessage[];
  blockedUserContents?: string[];
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Serve static frontend assets
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Handle chat API route
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return handleChatRequest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Build sanitized, compact history:
 * - Ensure single system prompt (yours + safety shim)
 * - Drop any assistant lines that look like 'blocked by guardrails'
 *   and drop the adjacent offending user turn (if present)
 * - Drop any user messages whose content is present in blockedUserContents
 * - Limit to last 16 messages to avoid dragging old risky text forward
 */
function buildModelMessages(
  raw: ChatMessage[],
  blockedUserContents: Set<string>
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  // Single system prompt
  msgs.push({
    role: "system",
    content: `${SYSTEM_PROMPT}\n\nSafety: ${SAFETY_SHIM}`,
  });

  // Clean up historical turns
  const cleaned: ChatMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];

    // Ignore any system prompts coming from client
    if (m.role === "system") continue;

    // Drop any user content we've previously marked as blocked
    if (m.role === "user" && typeof m.content === "string" && blockedUserContents.has(m.content)) {
      continue;
    }

    const looksLikeGuardrailNotice =
      m.role === "assistant" &&
      typeof m.content === "string" &&
      /blocked by guardrails/i.test(m.content);

    if (looksLikeGuardrailNotice) {
      // Drop this assistant message and (if adjacent) the previous user message
      if (cleaned.length && cleaned[cleaned.length - 1].role === "user") {
        cleaned.pop();
      }
      continue;
    }

    cleaned.push(m);
  }

  const windowed =
    cleaned.length > 16 ? cleaned.slice(cleaned.length - 16) : cleaned;

  return msgs.concat(windowed);
}

/** Parse AI Gateway error shapes robustly (fixes TS squiggles) */
function parseGatewayError(body: unknown): { code?: number; message?: string } {
  try {
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;

      // { error: [{ code, message }]} or { errors: [{ code, message }]}
      const arr1 = Array.isArray((b as any).error) ? (b as any).error : undefined;
      if (arr1 && arr1.length && typeof arr1[0] === "object") {
        return { code: (arr1[0] as any).code, message: (arr1[0] as any).message };
      }
      const arr2 = Array.isArray((b as any).errors) ? (b as any).errors : undefined;
      if (arr2 && arr2.length && typeof arr2[0] === "object") {
        return { code: (arr2[0] as any).code, message: (arr2[0] as any).message };
      }

      // { error: "string" } or { message: "string" } or { detail: "string" }
      if (typeof b.error === "string") return { message: b.error };
      if (typeof b.message === "string") return { message: b.message };
      if (typeof (b as any).detail === "string") return { message: (b as any).detail };
    }
  } catch {
    // fallthrough
  }
  return {};
}

/**
 * Handles the POST /api/chat request, calls the model, and streams the response
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    const raw = (await request.json()) as unknown as IncomingBody;
    const messages = Array.isArray(raw?.messages) ? raw!.messages! : [];
    const blocked = new Set(
      Array.isArray(raw?.blockedUserContents) ? raw!.blockedUserContents! : []
    );

    // Build sanitized model messages
    const modelMessages = buildModelMessages(messages, blocked);

    // Run LLM request via AI Gateway, requesting raw response
    const aiResponse = await env.AI.run(
      MODEL_ID,
      {
        messages: modelMessages,
        max_tokens: 2048,
        // Conservative decoding reduces borderline content volatility
        temperature: 0.2,
        top_p: 0.9,
      },
      {
        returnRawResponse: true,
        gateway: {
          id: "chatbot-gateway",
          skipCache: false,
          cacheTtl: 3600,
        },
      },
    );

    // Check if the response was blocked by Guardrails (e.g., HTTP 424)
    if (!aiResponse.ok) {
      let userMessage = "An error occurred while processing your request.";
      try {
        const body = await aiResponse.json();
        const { code, message } = parseGatewayError(body);

        if (code === 2016) userMessage = "Prompt was blocked by guardrails.";
        else if (code === 2017) userMessage = "Response was blocked by guardrails.";
        else if (typeof message === "string" && message.length) userMessage = message;
      } catch {
        // fallback to generic
      }

      return new Response(JSON.stringify({ error: userMessage }), {
        status: aiResponse.status, // e.g., 424
        headers: { "Content-Type": "application/json" },
      });
    }

    // Stream the AI response using SSE format
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = aiResponse.body?.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    if (reader) {
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = decoder.decode(value);
            // passthrough as SSE `data: {json}`
            await writer.write(encoder.encode(`data: ${textChunk}\n\n`));
          }
        } catch (err) {
          console.error("Streaming error:", err);
        } finally {
          await writer.close();
        }
      })();
    }

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(JSON.stringify({ error: "Failed to process request" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
