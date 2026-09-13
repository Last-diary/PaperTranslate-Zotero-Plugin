// MinerU API 客户端（移植自原项目 server/mineru.js 与 server/routes.js 中的测试逻辑）
// 差异：不再使用 Node Buffer；OSS 上传直接发送 Uint8Array；轮询支持插件卸载时中止。

import { sleep } from "./utils.mjs";
import { ctx } from "./context.mjs";
import { MINERU_FILES_PER_MINUTE, mineruRateLimitFor } from "./mineruRateLimit.mjs";

export class MineruClient {
  constructor(config, { rateLimit } = {}) {
    this.config = config;
    this.rateLimit = rateLimit || mineruRateLimitFor(config.mineru);
  }

  get settings() {
    return this.config.mineru;
  }

  requireKey() {
    if (!this.settings.apiKey) {
      throw new Error("缺少 MinerU API Token，请在 设置 → PaperTranslate 中配置。");
    }
  }

  payloadOptions() {
    return {
      model_version: this.settings.modelVersion,
      language: this.settings.language,
      enable_formula: this.settings.enableFormula,
      enable_table: this.settings.enableTable
    };
  }

  async fetch(pathname, options = {}, retries = 2, control = {}) {
    this.requireKey();
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0 && lastError?.status !== 429) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await sleep(delay);
      }

      await this.rateLimit.acquire(control.fileCount || 0, {
        ...control,
        shouldAbort: () => ctx.shuttingDown || Boolean(control.shouldAbort?.())
      });
      try {
        const response = await fetch(`${this.settings.baseUrl}${pathname}`, {
          ...options,
          headers: {
            "accept": "application/json",
            "authorization": `Bearer ${this.settings.apiKey}`,
            ...(options.body && !(options.body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
            ...(options.headers || {})
          }
        });
        const text = await response.text();

        if (response.status === 429) {
          this.rateLimit.defer(response.headers.get("retry-after"));
          lastError = new Error(`MinerU 请求受限：429 ${text.slice(0, 300)}`);
          lastError.status = 429;
          continue;
        }

        if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
          const wafError = new Error(`MinerU 访问被拦截（${response.status}），可能是网络防护触发，请稍后重试。`);
          wafError.status = response.status || 503;
          lastError = wafError;
          if (response.status === 403 || response.status === 503) continue;
          throw wafError;
        }

        let data = null;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }

        if (!response.ok || data.code !== 0) {
          const error = new Error(`MinerU 请求失败：${response.status} ${data.msg || text.slice(0, 300)}`);
          error.status = response.status || 502;
          if (response.status === 403 || response.status === 429 || response.status >= 500) {
            lastError = error;
            continue;
          }
          throw error;
        }
        return data.data || {};
      } catch (error) {
        const isRetryable = !error.status || error.status === 403 || error.status === 429 || error.status >= 500;
        if (isRetryable) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error("MinerU 请求失败，已达最大重试次数。");
  }

  async createUploadBatch({ name, dataId }, control = {}) {
    return this.createUploadBatchFiles([{ name, dataId }], control);
  }

  async createUploadBatchFiles(files, control = {}) {
    const entries = Array.from(files || []);
    if (!entries.length || entries.length > MINERU_FILES_PER_MINUTE) {
      throw new Error(`MinerU 单批上传文件数必须在 1 到 ${MINERU_FILES_PER_MINUTE} 之间。`);
    }
    return this.fetch("/file-urls/batch", {
      method: "POST",
      body: JSON.stringify({
        files: entries.map(({ name, dataId }) => ({
          name,
          data_id: dataId,
          is_ocr: this.settings.isOcr
        })),
        ...this.payloadOptions()
      })
    }, 2, { ...control, fileCount: entries.length });
  }

  async pollBatchResults(batchId, expectedFiles, shouldAbort = () => false) {
    const expected = Array.from(expectedFiles || []).map((entry) => ({
      name: String(entry?.name || ""),
      dataId: String(entry?.dataId || "")
    }));
    if (!batchId || !expected.length) {
      throw new Error("MinerU 批量轮询缺少任务或文件信息。");
    }
    const started = Date.now();
    while (Date.now() - started < this.settings.timeoutMs) {
      if (shouldAbort()) throw new Error("操作已取消。");
      const data = await this.fetch(`/extract-results/batch/${encodeURIComponent(batchId)}`, {}, 2, { shouldAbort });
      const results = Array.isArray(data.extract_result) ? data.extract_result : [];
      const matched = expected.map((entry) => results.find((item) => (
        (entry.dataId && item?.data_id === entry.dataId)
        || (entry.name && item?.file_name === entry.name)
      )) || null);
      if (matched.every((item) => item && ["done", "failed"].includes(item.state))) {
        return expected.map((entry, index) => ({ ...entry, result: matched[index] }));
      }
      await sleep(this.settings.pollIntervalMs);
    }
    throw new Error("MinerU 批量解析超时。");
  }

  async pollBatch(batchId, fileName, shouldAbort = () => false) {
    const [{ result }] = await this.pollBatchResults(
      batchId,
      [{ name: fileName, dataId: "" }],
      shouldAbort
    );
    if (result?.state === "done" && result.full_zip_url) return result;
    throw new Error(`MinerU 解析失败：${result?.err_msg || "unknown error"}`);
  }
}

// 上传文件到 MinerU 返回的 OSS 链接（移植自 server/importer.js）
export async function uploadToOss(uploadUrl, buffer) {
  let uploadResponse = null;
  let uploadError = "";
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(1000 * Math.pow(2, attempt), 4000));
    uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: buffer
    });
    if (uploadResponse.ok) return;
    uploadError = await uploadResponse.text().catch(() => "");
    if (uploadResponse.status !== 403 && uploadResponse.status < 500) break;
  }
  const status = uploadResponse?.status || "未知";
  throw new Error(`上传到 MinerU OSS 失败：${status} ${String(uploadError).slice(0, 240)}`.trim());
}

function mineruAuthFailed(status, bodyText) {
  if (status === 401 || status === 403) return true;
  return /token|api\s*key|apikey|auth|authorization|unauthorized|forbidden|认证|鉴权|授权|密钥|无权/i.test(bodyText);
}

// 设置页“测试 MinerU”按钮（移植自 server/routes.js）
export async function testMineruSettings(mineru = {}) {
  const apiKey = String(mineru.apiKey || "").trim();
  const baseUrl = String(mineru.baseUrl || "https://mineru.net/api/v4").trim().replace(/\/$/, "");
  if (!apiKey) throw new Error("请先填写 MinerU API Token。");

  const response = await fetch(`${baseUrl}/extract/task/${encodeURIComponent("papertranslate-test")}`, {
    method: "GET",
    headers: { "accept": "application/json", "authorization": `Bearer ${apiKey}` }
  });
  const text = await response.text();
  if (mineruAuthFailed(response.status, text)) {
    throw new Error(`MinerU 测试失败：${response.status} ${text.slice(0, 300)}`);
  }
  if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
    throw new Error(`MinerU 测试失败：${response.status} 返回了网页内容，请检查 Base URL。`);
  }
  return { message: "MinerU 测试通过：API 可访问，Token 已被接受" };
}
