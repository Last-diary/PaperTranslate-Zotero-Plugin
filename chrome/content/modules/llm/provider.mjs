// 大模型 Provider 工厂。新增厂商时在这里注册适配器，
// 具体适配器可以继续复用 OpenAI-compatible 基础客户端。

import {
  DEEPSEEK_PROVIDER_ID,
  createDeepSeekProvider
} from "./providers/deepseek.mjs";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAICompatibleProvider
} from "./providers/openaiCompatible.mjs";

const PROVIDER_FACTORIES = new Map([
  [DEEPSEEK_PROVIDER_ID, createDeepSeekProvider],
  [OPENAI_COMPATIBLE_PROVIDER_ID, createOpenAICompatibleProvider]
]);

export function createLlmProvider(llm = {}) {
  const provider = String(llm.provider || DEEPSEEK_PROVIDER_ID).trim().toLowerCase();
  const factory = PROVIDER_FACTORIES.get(provider);
  if (!factory) throw new Error(`暂不支持大模型服务商：${provider}`);
  return factory(llm.providers?.[provider] || llm.settings || {});
}

export async function testLlmSettings(llm = {}) {
  return createLlmProvider(llm).testConnection();
}
