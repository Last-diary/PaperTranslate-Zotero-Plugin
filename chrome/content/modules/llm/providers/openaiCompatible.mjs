// 可由用户直接配置的 OpenAI Chat Completions 兼容 Provider。
// 适用于 OpenAI、OpenRouter、硅基流动、LM Studio、Ollama 网关等兼容端点。

import {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL,
  OpenAICompatibleClient
} from "../openaiCompatible.mjs";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai_compatible";

export class OpenAICompatibleProvider {
  constructor(settings = {}) {
    this.id = OPENAI_COMPATIBLE_PROVIDER_ID;
    this.name = "OpenAI-compatible";
    this.protocol = OPENAI_CHAT_COMPLETIONS_PROTOCOL;
    this.settings = {
      apiKey: String(settings.apiKey || "").trim(),
      baseUrl: String(settings.baseUrl || "").trim(),
      model: String(settings.model || "").trim()
    };
    this.client = new OpenAICompatibleClient({
      baseUrl: this.settings.baseUrl,
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      providerName: this.name
    });
  }

  async createChatCompletion(request = {}, { json = false } = {}) {
    const payload = { ...request };
    if (json && !payload.response_format) {
      payload.response_format = { type: "json_object" };
    }
    return this.client.createChatCompletion(payload);
  }

  async testConnection() {
    const data = await this.createChatCompletion({
      temperature: 0,
      max_tokens: 4,
      messages: [
        { role: "system", content: "Reply with ok." },
        { role: "user", content: "test" }
      ]
    });
    if (!data.choices?.length) throw new Error("OpenAI-compatible 响应中没有 choices。");
    return {
      message: `OpenAI-compatible 测试通过：${this.settings.model}`,
      provider: this.id,
      protocol: this.protocol,
      model: this.settings.model
    };
  }
}

export function createOpenAICompatibleProvider(settings) {
  return new OpenAICompatibleProvider(settings);
}
