// 配置读取：包装 Services.prefs，对外提供与原项目 config.json 相同的结构。
// Zotero.Prefs 只管理 extensions.zotero.* 分支，插件偏好需直接走 Services.prefs。

const BRANCH = "extensions.papertranslate.";

function getString(key, fallback = "") {
  try {
    const value = Services.prefs.getStringPref(BRANCH + key, fallback);
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function getBool(key, fallback = false) {
  try {
    return Services.prefs.getBoolPref(BRANCH + key, fallback);
  } catch {
    return fallback;
  }
}

function getInt(key, fallback) {
  const value = parseInt(getString(key, ""), 10);
  return Number.isFinite(value) ? value : fallback;
}

export function getConfig() {
  return {
    deepseek: {
      apiKey: getString("deepseek.apiKey").trim(),
      baseUrl: getString("deepseek.baseUrl", "https://api.deepseek.com").trim() || "https://api.deepseek.com",
      model: getString("deepseek.model", "deepseek-v4-flash").trim() || "deepseek-v4-flash",
      thinkingEnabled: getBool("deepseek.thinkingEnabled", false),
      jsonMode: getBool("deepseek.jsonMode", true)
    },
    mineru: {
      apiKey: getString("mineru.apiKey").trim(),
      baseUrl: getString("mineru.baseUrl", "https://mineru.net/api/v4").trim() || "https://mineru.net/api/v4",
      modelVersion: getString("mineru.modelVersion", "vlm").trim() || "vlm",
      language: getString("mineru.language", "ch").trim() || "ch",
      isOcr: getBool("mineru.isOcr", false),
      enableFormula: getBool("mineru.enableFormula", true),
      enableTable: getBool("mineru.enableTable", true),
      pollIntervalMs: Math.max(1000, getInt("mineru.pollIntervalMs", 3000)),
      timeoutMs: Math.max(30000, getInt("mineru.timeoutMs", 600000))
    },
    translation: {
      translateReferences: getBool("translation.translateReferences", false),
      translateSupplement: getBool("translation.translateSupplement", false),
      translateAuthors: getBool("translation.translateAuthors", false)
    },
    tocEnhancement: {
      enabled: getBool("toc.enabled", true),
      forceRefresh: getBool("toc.forceRefresh", false),
      minHeadings: getInt("toc.minHeadings", 3),
      maxHeadings: getInt("toc.maxHeadings", 140)
    }
  };
}
