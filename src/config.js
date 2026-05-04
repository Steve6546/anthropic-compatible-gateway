import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(path = ".env") {
  const fullPath = resolve(process.cwd(), path);
  if (!existsSync(fullPath)) return {};

  const values = {};
  const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function getConfig(env = { ...loadDotEnv(), ...process.env }) {
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 4000),
    gatewayToken: env.ANTHROPIC_AUTH_TOKEN || env.GATEWAY_AUTH_TOKEN || "my-secret-gateway-token",
    provider: env.PROVIDER || "openai",
    defaultModel: env.ANTHROPIC_MODEL || aliasForOpenAIModel(env.OPENAI_MODEL || "gpt-5.3-codex"),
    openaiApiKey: env.OPENAI_API_KEY || "not-needed",
    openaiModel: env.OPENAI_MODEL || "gpt-5.3-codex",
    openaiBaseUrl: trimTrailingSlash(env.OPENAI_BASE_URL || "http://127.0.0.1:10531/v1"),
    providerTimeoutMs: Number(env.PROVIDER_TIMEOUT_MS || 60000),
    logFile: env.GATEWAY_LOG_FILE || "gateway.log",
    logEnabled: env.GATEWAY_LOG_ENABLED !== "false"
  };
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function aliasForOpenAIModel(model) {
  if (model === "gpt-5.5") return "claude-gpt-5-5";
  if (model === "gpt-5.3-codex") return "claude-gpt-5-3-codex";
  return "claude-gpt-5-4";
}
