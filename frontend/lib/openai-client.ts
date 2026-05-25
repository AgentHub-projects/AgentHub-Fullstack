export type OpenAIMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatCompletionChunk = {
  choices: Array<{
    delta: { content?: string; role?: string };
    finish_reason: string | null;
    index: number;
  }>;
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3001";

/**
 * Stream chat completions via SSE.
 * Yields content deltas as they arrive.
 */
export async function* streamChat(
  messages: OpenAIMessage[],
  model: string,
  conversationId?: string,
): AsyncGenerator<string, void, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (conversationId) {
    body.conversationId = conversationId;
  }

  const response = await fetch(`${API_BASE_URL}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "Unknown error");
    throw new Error(`Chat API error ${response.status}: ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const chunk: ChatCompletionChunk = JSON.parse(data);
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip unparseable chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Non-streaming chat completion.
 * Returns the full assistant response.
 */
export async function chatCompletion(
  messages: OpenAIMessage[],
  model: string,
  conversationId?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  if (conversationId) {
    body.conversationId = conversationId;
  }

  const response = await fetch(`${API_BASE_URL}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "Unknown error");
    throw new Error(`Chat API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}
