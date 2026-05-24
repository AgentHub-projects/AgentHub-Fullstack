import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ChatCompletionRequest } from "../services/chat.service";
import { ChatService } from "../services/chat.service";

@Controller("v1")
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get("models")
  listModels() {
    return this.chat.listModels();
  }

  @Get("models/:id")
  getModel(@Param("id") id: string) {
    return this.chat.getModel(id);
  }

  @Post("chat/completions")
  async chatCompletions(
    @Body() body: ChatCompletionRequest,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const stream = body.stream !== false;

    if (!stream) {
      // Non-streaming: buffer full response
      try {
        const result = await new Promise<{ content: string; error: string | null }>((resolve) => {
          this.chat.streamChat(
            body,
            () => {},
            (finalContent) => resolve({ content: finalContent, error: null }),
            (err) => resolve({ content: "", error: err.message }),
          );
        });

        if (result.error) {
          res.status(500).json({ error: { message: result.error, type: "server_error" } });
          return;
        }

        res.json({
          id: "chatcmpl-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (err) {
        res.status(500).json({
          error: { message: err instanceof Error ? err.message : String(err), type: "server_error" },
        });
      }
      return;
    }

    // SSE streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    try {
      await this.chat.streamChat(
        body,
        (chunk) => {
          if (aborted) return;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        (_finalContent) => {
          if (aborted) return;
          res.write("data: [DONE]\n\n");
          res.end();
        },
        (error) => {
          if (aborted) return;
          res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "server_error" } })}\n\n`);
          res.end();
        },
      );
    } catch (err) {
      if (!aborted && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } })}\n\n`);
        res.end();
      }
    }
  }
}
