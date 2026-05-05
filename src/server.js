import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { estimateTokensForRequest, listAnthropicModels, resolveModel } from "./anthropic.js";
import { callProvider, httpError } from "./providers.js";
import { createLogger } from "./logger.js";

export function createGatewayServer({ config = {}, fetchImpl = fetch } = {}) {
  const gatewayConfig = { ...getConfig({}), ...config };
  const logger = createLogger(gatewayConfig);
  return http.createServer(async (request, response) => {
    const path = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`).pathname;
    try {
      if (request.method === "HEAD" && path === "/") {
        response.writeHead(200);
        return response.end();
      }

      if (!isAuthorized(request, gatewayConfig.gatewayToken)) {
        throw httpError(401, "Invalid gateway authorization token", "authentication_error");
      }

      if (request.method === "GET" && path === "/v1/models") {
        return json(response, 200, listAnthropicModels());
      }

      if (request.method === "POST" && path === "/v1/messages/count_tokens") {
        const body = await readJson(request);
        return json(response, 200, { input_tokens: estimateTokensForRequest(body) });
      }

      if (request.method === "POST" && path === "/v1/messages") {
        const body = await readJson(request);
        logger.info("gateway.messages.request", { body: summarizeAnthropicRequest(body) });
        validateMessageRequest(body);
        const model = resolveModel(body.model, gatewayConfig);
        if (!model) throw httpError(400, "Unsupported model alias. Allowed aliases: claude-gpt-5-5, claude-gpt-5-4, claude-gpt-5-3-codex");
        const result = await callProvider({ ...model, body, config: gatewayConfig, fetchImpl, logger });
        logger.info("gateway.messages.response", { body: summarizeAnthropicMessage(result), streamRequested: Boolean(body.stream) });
        if (body.stream) return streamAnthropicMessage(response, result, logger);
        return json(response, 200, result);
      }

      throw httpError(404, "Route not found");
    } catch (error) {
      logger.error("gateway.error", error, { method: request.method, url: request.url });
      const body = {
        type: "error",
        error: {
          type: error.type || "internal_server_error",
          message: error.message || "Unexpected gateway error"
        }
      };
      logger.info("gateway.error_response", { status: error.status || 500, body });
      return json(response, error.status || 500, body);
    }
  });
}

function isAuthorized(request, gatewayToken) {
  return request.headers.authorization === `Bearer ${gatewayToken}`;
}

function validateMessageRequest(body) {
  if (!body || typeof body !== "object") throw httpError(400, "JSON body is required");
  if (!Array.isArray(body.messages)) throw httpError(400, "messages must be an array");
  if (!body.max_tokens && body.max_tokens !== 0) throw httpError(400, "max_tokens is required");
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function summarizeAnthropicRequest(body) {
  return {
    model: body?.model,
    max_tokens: body?.max_tokens,
    stream: Boolean(body?.stream),
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    has_system: Boolean(body?.system)
  };
}

function summarizeAnthropicMessage(message) {
  return {
    id: message?.id,
    type: message?.type,
    role: message?.role,
    model: message?.model,
    stop_reason: message?.stop_reason,
    content_blocks: Array.isArray(message?.content)
      ? message.content.map((block) => ({ type: block?.type, name: block?.name }))
      : [],
    usage: message?.usage
  };
}

function streamAnthropicMessage(response, message, logger) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  writeEvent(response, "message_start", { type: "message_start", message: { ...message, content: [] } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      writeEvent(response, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      writeEvent(response, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      writeEvent(response, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
      });
      writeEvent(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) }
      });
    } else {
      writeEvent(response, "content_block_start", { type: "content_block_start", index, content_block: block });
    }
    writeEvent(response, "content_block_stop", { type: "content_block_stop", index });
  });
  writeEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens }
  });
  writeEvent(response, "message_stop", { type: "message_stop" });
  response.end();
  logger?.info("gateway.messages.sse_complete", { id: message.id });
}

function writeEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = getConfig();
  const server = createGatewayServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`Anthropic-compatible gateway listening at http://${config.host}:${config.port}`);
  });
}
