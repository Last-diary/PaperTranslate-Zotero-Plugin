// DeepSeek Provider：复用 OpenAI Chat Completions 兼容客户端，
// 仅在此处组装 DeepSeek 默认值和 thinking/JSON Mode 等专属能力。

import {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL,
  OpenAICompatibleClient
} from "../openaiCompatible.mjs";

export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

export class DeepSeekProvider {
  constructor(settings = {}) {
    this.id = DEEPSEEK_PROVIDER_ID;
    this.name = "DeepSeek";
    this.protocol = OPENAI_CHAT_COMPLETIONS_PROTOCOL;
    this.settings = {
      apiKey: String(settings.apiKey || "").trim(),
      baseUrl: String(settings.baseUrl || DEEPSEEK_DEFAULT_BASE_URL).trim() || DEEPSEEK_DEFAULT_BASE_URL,
      model: String(settings.model || DEEPSEEK_DEFAULT_MODEL).trim() || DEEPSEEK_DEFAULT_MODEL,
      thinkingEnabled: settings.thinkingEnabled === true,
      jsonMode: settings.jsonMode !== false
    };
    this.client = new OpenAICompatibleClient({
      baseUrl: this.settings.baseUrl,
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      providerName: this.name
    });
  }

  validate() {
    if (!this.settings.apiKey) throw new Error("请先填写 DeepSeek API Key。");
    this.client.validate();
  }

  async createChatCompletion(request = {}, { json = false } = {}) {
    this.validate();
    const payload = {
      ...request,
      thinking: {
        type: this.settings.thinkingEnabled ? "enabled" : "disabled"
      }
    };
    if (json && this.settings.jsonMode && !payload.response_format) {
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
    if (!data.choices?.length) throw new Error("DeepSeek 响应中没有 choices。");
    return {
      message: `DeepSeek 测试通过：${this.settings.model}`,
      provider: this.id,
      protocol: this.protocol,
      model: this.settings.model
    };
  }
}

export function createDeepSeekProvider(settings) {
  return new DeepSeekProvider(settings);
}
