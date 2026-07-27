// PaperTranslate 默认配置（Zotero 7+ 在插件安装/启用时读取插件根目录的 prefs.js）
// 数值型设置保存为字符串，读取时由 config.mjs 解析，避免偏好绑定类型问题。

pref("extensions.papertranslate.deepseek.apiKey", "");
pref("extensions.papertranslate.deepseek.baseUrl", "https://api.deepseek.com");
pref("extensions.papertranslate.deepseek.model", "deepseek-v4-flash");
pref("extensions.papertranslate.deepseek.thinkingEnabled", false);
pref("extensions.papertranslate.deepseek.jsonMode", true);

pref("extensions.papertranslate.mineru.apiKey", "");
pref("extensions.papertranslate.mineru.baseUrl", "https://mineru.net/api/v4");
pref("extensions.papertranslate.mineru.modelVersion", "vlm");
pref("extensions.papertranslate.mineru.language", "ch");
pref("extensions.papertranslate.mineru.isOcr", false);
pref("extensions.papertranslate.mineru.enableFormula", true);
pref("extensions.papertranslate.mineru.enableTable", true);
pref("extensions.papertranslate.mineru.pollIntervalMs", "3000");
pref("extensions.papertranslate.mineru.timeoutMs", "600000");

// true 表示翻译该部分，false 表示跳过（与原项目 translation.* 语义一致）
pref("extensions.papertranslate.translation.translateReferences", false);
pref("extensions.papertranslate.translation.translateSupplement", false);
pref("extensions.papertranslate.translation.translateAuthors", false);

pref("extensions.papertranslate.toc.enabled", true);
pref("extensions.papertranslate.toc.forceRefresh", false);
pref("extensions.papertranslate.toc.minHeadings", "3");
pref("extensions.papertranslate.toc.maxHeadings", "140");
