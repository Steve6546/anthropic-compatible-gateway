import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createGatewayServer } from "../src/server.js";
import { getConfig } from "../src/config.js";
import {
  anthropicMessagesToOpenAIResponses,
  openAIResponseToAnthropicMessage,
  estimateAnthropicTokens
} from "../src/anthropic.js";

const auth = { authorization: "Bearer my-secret-gateway-token" };

async function withServer(handler, test, configOverrides = {}) {
  const server = createGatewayServer({
    config: {
      gatewayToken: "my-secret-gateway-token",
      port: 0,
      provider: "openai",
      defaultModel: "claude-gpt-5-3-codex",
      openaiModel: "gpt-5.3-codex",
      logEnabled: false,
      ...configOverrides
    },
    fetchImpl: handler
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await test(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readEventually(path, pattern) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const text = readFileSync(path, "utf8");
      if (!pattern || pattern.test(text)) return text;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readFileSync(path, "utf8");
}

describe("gateway routes", () => {
  it("rejects requests without the configured bearer token", async () => {
    await withServer(async () => {
      throw new Error("provider should not be called");
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/models`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        type: "error",
        error: { type: "authentication_error", message: "Invalid gateway authorization token" }
      });
    });
  });

  it("returns Claude-detectable model ids", async () => {
    await withServer(async () => {
      throw new Error("provider should not be called");
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/models`, { headers: auth });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, {
        data: [
          { id: "GPT-5.5", display_name: "GPT-5.5 via OpenAI" },
          { id: "GPT-5.5 Instant", display_name: "GPT-5.5 Instant via OpenAI" },
          { id: "GPT-5.4", display_name: "GPT-5.4 via OpenAI" },
          { id: "gpt-5.3-codex", display_name: "GPT-5.3 Codex via OpenAI" },
          { id: "claude-gpt-5-5", display_name: "GPT-5.5 via OpenAI" },
          { id: "claude-gpt-5-4", display_name: "GPT-5.4 via OpenAI" },
          { id: "claude-gpt-5-3-codex", display_name: "GPT-5.3 Codex via OpenAI" }
        ]
      });
    });
  });

  it("accepts Claude Code query strings on models and messages routes", async () => {
    await withServer(async () => Response.json({
      id: "resp_query",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "query ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }), async (baseUrl) => {
      const models = await fetch(`${baseUrl}/v1/models?limit=1000`, { headers: auth });
      assert.equal(models.status, 200);

      const message = await fetch(`${baseUrl}/v1/messages?beta=true`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }]
        })
      });
      assert.equal(message.status, 200);
      assert.deepEqual((await message.json()).content, [{ type: "text", text: "query ok" }]);
    });
  });

  it("responds to root HEAD health checks without requiring auth", async () => {
    await withServer(async () => {
      throw new Error("provider should not be called");
    }, async (baseUrl) => {
      const response = await fetch(baseUrl, { method: "HEAD" });
      assert.equal(response.status, 200);
    });
  });

  it("proxies non-stream requests through OpenAI Responses API", async () => {
    let providerRequest;
    await withServer(async (url, init) => {
      providerRequest = { url, init, body: JSON.parse(init.body) };
      return Response.json({
        id: "resp_1",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from openai" }]
        }],
        usage: { input_tokens: 12, output_tokens: 3 }
      });
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 64,
          system: "Be direct.",
          messages: [{ role: "user", content: "Say hello" }]
        })
      });

      assert.equal(response.status, 200);
      assert.equal(providerRequest.url, "http://127.0.0.1:10531/v1/responses");
      assert.equal(providerRequest.init.headers.authorization, "Bearer not-needed");
      assert.equal(providerRequest.body.model, "gpt-5.3-codex");
      assert.equal(providerRequest.body.instructions, "Be direct.");
      assert.equal(providerRequest.body.max_output_tokens, 64);
      assert.deepEqual(providerRequest.body.input, [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello" }]
      }]);
      const body = await response.json();
      assert.equal(body.type, "message");
      assert.equal(body.role, "assistant");
      assert.deepEqual(body.content, [{ type: "text", text: "hello from openai" }]);
      assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 3 });
    });
  });

  it("does not write raw prompt content to gateway logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-log-"));
    const logFile = join(dir, "gateway.log");
    try {
      await withServer(async () => Response.json({
        id: "resp_log_test",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hidden response text" }] }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-gpt-5-3-codex",
            max_tokens: 64,
            system: "secret memory content",
            messages: [{ role: "user", content: "private user content" }]
          })
        });

        assert.equal(response.status, 200);
      }, { logEnabled: true, logFile });

      const logs = await readEventually(logFile, /"has_system":true/);
      assert.doesNotMatch(logs, /secret memory content/);
      assert.doesNotMatch(logs, /private user content/);
      assert.doesNotMatch(logs, /hidden response text/);
      assert.match(logs, /"has_system":true/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to OpenAI-compatible chat completions when Responses returns no content", async () => {
    const requests = [];
    await withServer(async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/responses")) {
        return Response.json({
          id: "resp_empty",
          object: "response",
          status: "completed",
          output: [],
          usage: { input_tokens: 7, output_tokens: 13 }
        });
      }
      return Response.json({
        id: "chatcmpl_1",
        choices: [{ message: { role: "assistant", content: "Hi from chat fallback." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 5 }
      });
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "hi" }]
        })
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.content, [{ type: "text", text: "Hi from chat fallback." }]);
      assert.deepEqual(requests.map((request) => request.url), [
        "http://127.0.0.1:10531/v1/responses",
        "http://127.0.0.1:10531/v1/chat/completions"
      ]);
      assert.equal(requests[1].body.model, "gpt-5.3-codex");
    });
  });

  it("uses chat completions directly for tool-result follow-up requests", async () => {
    const requests = [];
    await withServer(async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json({
        id: "chatcmpl_tool_followup",
        choices: [{ message: { role: "assistant", content: "package read" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 }
      });
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "package.json" } }]
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "call_1", content: "package contents" }]
            }
          ]
        })
      });

      assert.equal(response.status, 200);
      assert.deepEqual(requests.map((request) => request.url), ["http://127.0.0.1:10531/v1/chat/completions"]);
      assert.deepEqual(requests[0].body.messages.map((message) => message.role), ["assistant", "tool"]);
    });
  });

  it("does not report non-model provider validation errors as model availability errors", async () => {
    await withServer(async () => Response.json({
      error: { message: "No tool call found for function call output with call_id call_1." }
    }, { status: 400 }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }]
        })
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /No tool call found/);
    });
  });

  it("returns valid SSE instead of hanging when Claude Code requests streaming", async () => {
    await withServer(async () => Response.json({
      id: "resp_stream_test",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "streamed hi" }] }],
      usage: { input_tokens: 2, output_tokens: 2 }
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }]
        })
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const text = await response.text();
      assert.match(text, /event: message_start/);
      assert.match(text, /event: content_block_delta/);
      assert.match(text, /event: message_stop/);
    });
  });

  it("uses non-streaming provider fallback even when Claude Code requests streaming", async () => {
    const requests = [];
    await withServer(async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith("/responses")) {
        return Response.json({ id: "resp_empty_stream", output: [], usage: { input_tokens: 1, output_tokens: 1 } });
      }
      return Response.json({
        id: "chatcmpl_stream_fallback",
        choices: [{ message: { role: "assistant", content: "stream fallback hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      });
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }]
        })
      });

      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /stream fallback hi/);
      assert.deepEqual(requests.map((request) => request.body.stream), [false, false]);
    });
  });

  it("times out provider calls instead of hanging forever", async () => {
    await withServer(() => new Promise(() => {}), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }]
        })
      });

      assert.equal(response.status, 504);
      assert.deepEqual(await response.json(), {
        type: "error",
        error: { type: "provider_timeout", message: "openai-oauth request timed out after 60 seconds" }
      });
    }, { providerTimeoutMs: 10 });
  });

  it("maps GPT 5 aliases to only the allowed OpenAI model ids", async () => {
    const requests = [];
    await withServer(async (url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({
        id: "resp_alias",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1 }
      });
    }, async (baseUrl) => {
      for (const model of ["GPT-5.5", "GPT-5.5 Instant", "GPT-5.4", "gpt-5.3-codex", "claude-gpt-5-5", "claude-gpt-5-4", "claude-gpt-5-3-codex"]) {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: "user", content: "test" }]
          })
        });
        assert.equal(response.status, 200);
      }
    });

    assert.deepEqual(requests.map((request) => request.model), ["gpt-5.5", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex"]);
  });

  it("returns a clear error when OpenAI rejects an unavailable model", async () => {
    await withServer(async () => Response.json({
      error: { message: "model_not_found" }
    }, { status: 404 }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          max_tokens: 16,
          messages: [{ role: "user", content: "test" }]
        })
      });

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        type: "error",
        error: {
          type: "provider_error",
          message: "The requested OpenAI model is not available on this account or API."
        }
      });
    });
  });

  it("counts tokens without calling a provider", async () => {
    await withServer(async () => {
      throw new Error("provider should not be called");
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-gpt-5-3-codex",
          messages: [{ role: "user", content: "one two three four" }]
        })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { input_tokens: estimateAnthropicTokens("one two three four") });
    });
  });

  it("rejects JSON request bodies larger than the gateway limit", async () => {
    await withServer(async () => {
      throw new Error("provider should not be called");
    }, async (baseUrl) => {
      const oversizedBody = JSON.stringify({ content: "x".repeat(10 * 1024 * 1024) });
      const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: oversizedBody
      });

      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), {
        type: "error",
        error: { type: "request_too_large", message: "JSON body exceeds 10 MB limit" }
      });
    });
  });
});

describe("configuration", () => {
  it("defaults to the local openai-oauth endpoint and localhost gateway binding", () => {
    const config = getConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.openaiBaseUrl, "http://127.0.0.1:10531/v1");
    assert.equal(config.openaiApiKey, "not-needed");
    assert.equal(config.openaiModel, "gpt-5.3-codex");
    assert.equal(config.defaultModel, "claude-gpt-5-3-codex");
  });
});

describe("translation helpers", () => {
  it("translates Anthropic text and tool definitions to OpenAI Responses format", () => {
    const translated = anthropicMessagesToOpenAIResponses({
      model: "claude-gpt-5-4",
      max_tokens: 32,
      tools: [{
        name: "lookup",
        description: "Look up a value",
        input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
      }],
      messages: [{ role: "user", content: [{ type: "text", text: "find x" }] }]
    }, "gpt-5.4");

    assert.equal(translated.model, "gpt-5.4");
    assert.equal(translated.max_output_tokens, 32);
    assert.deepEqual(translated.tools[0], {
      type: "function",
      name: "lookup",
      description: "Look up a value",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
    });
  });

  it("translates OpenAI Responses function calls to Anthropic tool_use blocks", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_2",
      output: [{
        id: "call_1",
        type: "function_call",
        name: "lookup",
        arguments: "{\"q\":\"x\"}"
      }],
      usage: { input_tokens: 5, output_tokens: 2 }
    }, "claude-gpt-5-4");

    assert.equal(result.stop_reason, "tool_use");
    assert.deepEqual(result.content, [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }]);
  });

  it("extracts text from common OpenAI Responses shapes", () => {
    const topLevel = openAIResponseToAnthropicMessage({
      id: "resp_top",
      output_text: "hello from output_text",
      usage: { input_tokens: 1, output_tokens: 1 }
    }, "claude-gpt-5-3-codex");
    assert.deepEqual(topLevel.content, [{ type: "text", text: "hello from output_text" }]);

    const nestedText = openAIResponseToAnthropicMessage({
      id: "resp_nested",
      output: [{ type: "message", content: [{ type: "text", text: "hello from nested text" }] }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }, "claude-gpt-5-3-codex");
    assert.deepEqual(nestedText.content, [{ type: "text", text: "hello from nested text" }]);
  });

  it("cleans malformed file_path suffixes in OpenAI tool call arguments", () => {
    const result = openAIResponseToAnthropicMessage({
      id: "resp_bad_path",
      output: [{
        id: "call_bad",
        type: "function_call",
        name: "Read",
        arguments: "{\"file_path\":\"C:\\\\Users\\\\dlwta\\\\OneDrive\\\\Documents\\\\New project 19\\\\package.json'}]}\",\"offset\":0}"
      }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }, "claude-gpt-5-3-codex");

    assert.equal(result.content[0].input.file_path, "C:\\Users\\dlwta\\OneDrive\\Documents\\New project 19\\package.json");
  });

  it("cleans malformed file_path suffixes in chat tool call arguments", async () => {
    const { openAIChatToAnthropicMessage } = await import("../src/anthropic.js");
    const result = openAIChatToAnthropicMessage({
      id: "chat_bad_path",
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_bad",
            type: "function",
            function: {
              name: "Read",
              arguments: "{\"file_path\":\"C:\\\\Users\\\\dlwta\\\\OneDrive\\\\Documents\\\\New project 19\\\\README.md'}]}\",\"offset\":0}"
            }
          }]
        },
        finish_reason: "tool_calls"
      }]
    }, "claude-gpt-5-3-codex");

    assert.equal(result.content[0].input.file_path, "C:\\Users\\dlwta\\OneDrive\\Documents\\New project 19\\README.md");
  });
});
