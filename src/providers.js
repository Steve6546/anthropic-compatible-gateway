import {
  anthropicMessagesToOpenAI,
  anthropicMessagesToOpenAIResponses,
  openAIChatToAnthropicMessage,
  openAIResponseToAnthropicMessage
} from "./anthropic.js";

export async function callProvider({ publicModel, providerModel, body, config, fetchImpl = fetch, logger }) {
  if (config.provider !== "openai") throw httpError(400, "Only PROVIDER=openai is supported");
  if (shouldUseChatCompletions(body)) {
    logger?.info("provider.chat_completions.direct", {
      reason: "request includes tools or tool_result blocks",
      publicModel,
      providerModel
    });
    return callOpenAIChatCompletions({
      url: `${config.openaiBaseUrl}/chat/completions`,
      apiKey: config.openaiApiKey,
      body: anthropicMessagesToOpenAI({ ...body, stream: false }, providerModel),
      publicModel,
      fetchImpl,
      timeoutMs: config.providerTimeoutMs,
      logger
    });
  }

  const responseResult = await callOpenAIResponses({
    url: `${config.openaiBaseUrl}/responses`,
    apiKey: config.openaiApiKey,
    body: anthropicMessagesToOpenAIResponses(body, providerModel),
    publicModel,
    fetchImpl,
    timeoutMs: config.providerTimeoutMs,
    logger
  });
  if (responseResult.content.length > 0 || responseResult.stop_reason === "tool_use") return responseResult;

  logger?.info("provider.responses.empty_content_fallback", {
    reason: "OpenAI-compatible /responses returned no text content",
    publicModel,
    providerModel
  });

  return callOpenAIChatCompletions({
    url: `${config.openaiBaseUrl}/chat/completions`,
    apiKey: config.openaiApiKey,
    body: anthropicMessagesToOpenAI({ ...body, stream: false }, providerModel),
    publicModel,
    fetchImpl,
    timeoutMs: config.providerTimeoutMs,
    logger
  });
}

async function callOpenAIResponses({ url, apiKey, body, publicModel, fetchImpl, timeoutMs, logger }) {
  if (!apiKey) throw httpError(500, "Provider API key is not configured");
  logger?.info("provider.responses.request", { url, body });
  const data = await postJson({ url, apiKey, body, fetchImpl, timeoutMs, logger, eventPrefix: "provider.responses" });
  const message = openAIResponseToAnthropicMessage(data, publicModel);
  logger?.info("provider.responses.translated", { message });
  return message;
}

async function callOpenAIChatCompletions({ url, apiKey, body, publicModel, fetchImpl, timeoutMs, logger }) {
  if (!apiKey) throw httpError(500, "Provider API key is not configured");
  logger?.info("provider.chat_completions.request", { url, body });
  const data = await postJson({ url, apiKey, body, fetchImpl, timeoutMs, logger, eventPrefix: "provider.chat_completions" });
  const message = openAIChatToAnthropicMessage(data, publicModel);
  logger?.info("provider.chat_completions.translated", { message });
  return message;
}

async function postJson({ url, apiKey, body, fetchImpl, timeoutMs, logger, eventPrefix }) {
  const controller = new AbortController();
  let rejectTimer;
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await Promise.race([
      fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }),
      new Promise((_, reject) => {
        rejectTimer = setTimeout(() => reject(httpError(504, "openai-oauth request timed out after 60 seconds", "provider_timeout")), timeoutMs);
      })
    ]);
  } catch (error) {
    if (error.name === "AbortError") throw httpError(504, "openai-oauth request timed out after 60 seconds", "provider_timeout");
    throw error;
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(rejectTimer);
  }

  const text = await response.text();
  logger?.info(`${eventPrefix}.raw_response`, { status: response.status, ok: response.ok, body: safeJsonOrText(text) });
  if (!response.ok) throw providerHttpErrorFromText(response, text);

  try {
    return JSON.parse(text);
  } catch {
    throw httpError(502, "Provider returned invalid JSON", "provider_error");
  }
}

export function httpError(status, message, type = "invalid_request_error") {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  return error;
}

function providerHttpErrorFromText(response, text) {
  const parsed = safeJsonOrText(text);
  const message = typeof parsed === "object" ? parsed?.error?.message || text : text;
  if (response.status === 404 || (response.status === 400 && /model|not found|not available/i.test(message))) {
    return httpError(response.status, "The requested OpenAI model is not available on this account or API.", "provider_error");
  }
  return httpError(response.status, `Provider error: ${message || response.statusText}`, "provider_error");
}

function safeJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function shouldUseChatCompletions(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  for (const message of body.messages || []) {
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.some((part) => part?.type === "tool_result" || part?.type === "tool_use")) return true;
  }
  return false;
}
