export const PUBLIC_MODELS = [
  { id: "claude-gpt-5-5", providerModel: "gpt-5.5", displayName: "GPT-5.5 via OpenAI" },
  { id: "claude-gpt-5-4", providerModel: "gpt-5.4", displayName: "GPT-5.4 via OpenAI" },
  { id: "claude-gpt-5-3-codex", providerModel: "gpt-5.3-codex", displayName: "GPT-5.3 Codex via OpenAI" }
];

export function listAnthropicModels() {
  return {
    data: PUBLIC_MODELS.map((model) => ({
      id: model.id,
      display_name: model.displayName
    }))
  };
}

export function resolveModel(requestedModel, config) {
  const model = requestedModel || config.defaultModel;
  const mapped = PUBLIC_MODELS.find((entry) => entry.id === model);
  if (!mapped) return null;
  return { publicModel: model, providerModel: mapped.providerModel };
}

export function anthropicMessagesToOpenAIResponses(body, providerModel) {
  const result = {
    model: providerModel,
    input: anthropicMessagesToResponseInput(body.messages || []),
    instructions: body.system ? contentToText(body.system) : undefined,
    max_output_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: false
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} }
    }));
  }

  if (body.tool_choice) {
    result.tool_choice = toResponsesToolChoice(body.tool_choice);
  }

  return removeUndefined(result);
}

export function anthropicMessagesToOpenAI(body, providerModel) {
  const messages = [];
  if (body.system) {
    messages.push({ role: "system", content: contentToText(body.system) });
  }

  for (const message of body.messages || []) {
    if (message.role === "assistant") {
      messages.push(anthropicAssistantToOpenAI(message));
    } else if (message.role === "user") {
      messages.push(...anthropicUserToOpenAI(message));
    }
  }

  const result = {
    model: providerModel,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: Boolean(body.stream)
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} }
      }
    }));
  }

  if (body.tool_choice) {
    result.tool_choice = toOpenAIToolChoice(body.tool_choice);
  }

  return removeUndefined(result);
}

export function openAIResponseToAnthropicMessage(data, publicModel) {
  const content = [];
  if (typeof data.output_text === "string" && data.output_text) {
    content.push({ type: "text", text: data.output_text });
  }
  for (const item of data.output || []) {
    if (typeof item.text === "string" && item.text) {
      content.push({ type: "text", text: item.text });
    }
    if (item.type === "message") {
      for (const part of item.content || []) {
        if ((part.type === "output_text" || part.type === "text") && part.text) content.push({ type: "text", text: part.text });
      }
    }
    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: cleanToolInput(parseJsonObject(item.arguments || "{}"))
      });
    }
  }

  return {
    id: data.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: publicModel,
    content,
    stop_reason: content.some((part) => part.type === "tool_use") ? "tool_use" : responseStopReason(data),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0
    }
  };
}

export function openAIChatToAnthropicMessage(data, publicModel) {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name || call.name,
      input: cleanToolInput(parseJsonObject(call.function?.arguments || call.arguments || "{}"))
    });
  }

  return {
    id: data.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: publicModel,
    content,
    stop_reason: content.some((part) => part.type === "tool_use") ? "tool_use" : openAIStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0
    }
  };
}

export function estimateTokensForRequest(body) {
  const text = [
    contentToText(body.system || ""),
    ...(body.messages || []).map((message) => contentToText(message.content))
  ].join("\n");
  return estimateAnthropicTokens(text);
}

export function estimateAnthropicTokens(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part.type === "text") return part.text || "";
    if (part.type === "tool_result") return contentToText(part.content || "");
    if (part.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function anthropicAssistantToOpenAI(message) {
  const result = { role: "assistant", content: "" };
  const toolCalls = [];
  for (const part of Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]) {
    if (part.type === "text") result.content += part.text || "";
    if (part.type === "tool_use") {
      toolCalls.push({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
      });
    }
  }
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}

function anthropicMessagesToResponseInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      input.push({
        type: "message",
        role: "assistant",
        content: responseContentParts(message.content, "output_text")
      });
    } else if (message.role === "user") {
      input.push(...anthropicUserToResponseInput(message));
    }
  }
  return input;
}

function anthropicUserToResponseInput(message) {
  const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
  const input = [];
  const textParts = [];
  for (const part of content) {
    if (part.type === "tool_result") {
      input.push({
        type: "function_call_output",
        call_id: part.tool_use_id,
        output: contentToText(part.content || "")
      });
    } else {
      textParts.push(part);
    }
  }
  if (textParts.length > 0) {
    input.unshift({
      type: "message",
      role: "user",
      content: responseContentParts(textParts, "input_text")
    });
  }
  return input;
}

function responseContentParts(content, textType) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
  return blocks.map((part) => {
    if (part.type === "text") return { type: textType, text: part.text || "" };
    if (part.type === "image" && part.source?.data) {
      return {
        type: "input_image",
        image_url: `data:${part.source.media_type};base64,${part.source.data}`
      };
    }
    return null;
  }).filter(Boolean);
}

function anthropicUserToOpenAI(message) {
  const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
  const messages = [];
  const textParts = [];
  for (const part of content) {
    if (part.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: part.tool_use_id,
        content: contentToText(part.content || "")
      });
    } else {
      textParts.push(part);
    }
  }
  if (textParts.length > 0) {
    messages.unshift({ role: "user", content: textParts.map(openAIContentPart).filter(Boolean) });
    if (messages[0].content.length === 1 && messages[0].content[0].type === "text") {
      messages[0].content = messages[0].content[0].text;
    }
  }
  return messages;
}

function openAIContentPart(part) {
  if (part.type === "text") return { type: "text", text: part.text || "" };
  if (part.type === "image" && part.source?.data) {
    return {
      type: "image_url",
      image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` }
    };
  }
  return null;
}

function toOpenAIToolChoice(choice) {
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  return undefined;
}

function toResponsesToolChoice(choice) {
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") return { type: "function", name: choice.name };
  return undefined;
}

function openAIStopReason(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

function responseStopReason(data) {
  if (data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens") return "max_tokens";
  return "end_turn";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cleanToolInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const cleaned = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== ""));
  if (typeof cleaned.file_path === "string") {
    cleaned.file_path = cleanFilePath(cleaned.file_path);
  }
  return cleaned;
}

function cleanFilePath(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(.+?\.(?:json|md|js|mjs|cjs|ts|tsx|jsx|py|txt|yml|yaml|toml|lock|html|css|scss|ps1|sh|bat|cmd|xml|csv|env))(?:['"`\]\}\),\{].*)?$/i);
  return match ? match[1] : trimmed;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
