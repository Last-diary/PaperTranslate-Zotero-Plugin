// OpenAI Chat Completions 兼容协议客户端。
// Provider 适配器只负责默认值、能力检测和厂商专属参数，HTTP 细节集中在这里。

export const OPENAI_CHAT_COMPLETIONS_PROTOCOL = "openai_chat_compat";

export function normalizeOpenAICompatibleBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function responseErrorBody(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function parseResponseJson(text, providerName) {
  if (!text) throw new Error(`${providerName} 返回了空响应。`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${providerName} 返回的不是有效 JSON：${responseErrorBody(text)}`);
  }
}

export function chatCompletionText(data) {
  return String(data?.choices?.[0]?.message?.content || "");
}

export class OpenAICompatibleClient {
  constructor({
    baseUrl,
    apiKey = "",
    model,
    providerName = "OpenAI-compatible"
  } = {}) {
    this.baseUrl = normalizeOpenAICompatibleBaseUrl(baseUrl);
    this.apiKey = String(apiKey || "").trim();
    this.model = String(model || "").trim();
    this.providerName = String(providerName || "OpenAI-compatible");
  }

  validate() {
    if (!this.baseUrl) throw new Error(`请先填写 ${this.providerName} Base URL。`);
    if (!this.model) throw new Error(`请先填写 ${this.providerName} 模型。`);
  }

  async createChatCompletion(request = {}) {
    this.validate();
    const headers = {
      "content-type": "application/json"
    };
    // 本地 OpenAI-compatible 服务可能不要求鉴权，因此基础层允许空 Key。
    // 是否必须提供 Key 由具体 Provider 适配器校验。
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...request,
        model: String(request.model || this.model).trim()
      })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${this.providerName} 请求失败：${response.status} ${responseErrorBody(text)}`
      );
    }
    return parseResponseJson(text, this.providerName);
  }
}
