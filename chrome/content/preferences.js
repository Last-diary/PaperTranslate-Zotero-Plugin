// 设置面板脚本：为“测试”按钮接线。
// 注意：Zotero 9 中每个设置面板脚本运行在独立全局作用域，需自行 import 模块。

var PaperTranslate_Preferences = (function () {
  let getConfig = null;
  let testLlmSettings = null;
  let testMineruSettings = null;
  let clearAllTranslationCaches = null;
  let clearAllPaperTranslateData = null;
  let getPaperTranslateStorageUsage = null;
  let selectedLlmProvider = null;
  try {
    ({ getConfig } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/config.mjs"));
    ({ testLlmSettings } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/llm/provider.mjs"));
    ({ testMineruSettings } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/mineru.mjs"));
    ({
      clearAllTranslationCaches,
      clearAllPaperTranslateData,
      getPaperTranslateStorageUsage
    } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/storage.mjs"));
  } catch (error) {
    Cu.reportError(error);
  }

  function bindTest(buttonId, statusId, run) {
    const button = document.getElementById(buttonId);
    const status = document.getElementById(statusId);
    if (!button || !status) return;
    const setStatus = (text, state = "") => {
      status.setAttribute("value", text);
      status.style.color = state === "success"
        ? "#2e7d32"
        : state === "error"
          ? "#c62828"
          : "";
    };
    button.addEventListener("click", async () => {
      if (!run) {
        setStatus("模块加载失败，请重启 Zotero 后重试。", "error");
        return;
      }
      setStatus("测试中…");
      try {
        const result = await run();
        setStatus(result.message, "success");
      } catch (error) {
        setStatus(error.message || String(error), "error");
      }
    });
  }

  function bindLlmProviderSections() {
    const provider = document.getElementById("papertranslate-preferences-llm-provider");
    const deepseek = document.getElementById("papertranslate-preferences-deepseek-settings");
    const compatible = document.getElementById("papertranslate-preferences-openai-compatible-settings");
    const description = document.getElementById("papertranslate-preferences-llm-provider-description");
    const status = document.getElementById("papertranslate-test-llm-status");
    if (!provider || !deepseek || !compatible) return;

    const update = (requestedValue = "") => {
      const value = requestedValue || provider.value || getConfig?.()?.llm?.provider || "deepseek";
      selectedLlmProvider = value;
      deepseek.hidden = value !== "deepseek";
      compatible.hidden = value !== "openai_compatible";
      if (description) {
        description.textContent = value === "deepseek"
          ? "兼容 /chat/completions，并支持“允许思考”等专属参数。"
          : "使用标准 /chat/completions 兼容接口。";
      }
      status?.setAttribute("value", "");
      if (status) status.style.color = "";
    };
    const updateAfterMenuCloses = (event) => {
      const requestedValue = event.target?.value || "";
      // Zotero 的原生 menulist 会在 command 事件结束后完成选择和 preference 同步。
      // 与 Zotero 官方设置页保持一致，下一轮事件循环再更新依赖该值的 UI。
      setTimeout(() => update(requestedValue || provider.value));
    };
    provider.addEventListener("command", updateAfterMenuCloses);
    provider.addEventListener("change", updateAfterMenuCloses);
    provider.addEventListener("syncfrompreference", updateAfterMenuCloses);
    update(getConfig?.()?.llm?.provider || provider.value);
  }

  function inputValue(id, fallback = "") {
    const input = document.getElementById(id);
    return input ? String(input.value || "").trim() : fallback;
  }

  function checkboxValue(id, fallback = false) {
    const checkbox = document.getElementById(id);
    return checkbox ? checkbox.checked === true : fallback;
  }

  function llmConfigFromForm() {
    const llm = getConfig().llm;
    const provider = selectedLlmProvider
      || document.getElementById("papertranslate-preferences-llm-provider")?.value
      || llm.provider;
    let settings;
    if (provider === "openai_compatible") {
      const saved = llm.providers.openai_compatible || {};
      settings = {
        apiKey: inputValue("papertranslate-preferences-openai-compatible-api-key", saved.apiKey),
        baseUrl: inputValue("papertranslate-preferences-openai-compatible-base-url", saved.baseUrl),
        model: inputValue("papertranslate-preferences-openai-compatible-model", saved.model)
      };
    } else {
      const saved = llm.providers.deepseek || {};
      settings = {
        ...saved,
        apiKey: inputValue("papertranslate-preferences-deepseek-api-key", saved.apiKey),
        baseUrl: inputValue("papertranslate-preferences-deepseek-base-url", saved.baseUrl),
        model: inputValue("papertranslate-preferences-deepseek-model", saved.model),
        thinkingEnabled: checkboxValue(
          "papertranslate-preferences-deepseek-thinking-enabled",
          saved.thinkingEnabled
        )
      };
    }
    return {
      ...llm,
      provider,
      settings,
      providers: {
        ...llm.providers,
        [provider]: settings
      }
    };
  }

  function confirmClearData({ title, text, buttonLabel }) {
    const prompt = Services.prompt;
    const buttonFlags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING
      + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL
      + prompt.BUTTON_POS_1_DEFAULT;
    return prompt.confirmEx(
      window,
      title,
      text,
      buttonFlags,
      buttonLabel,
      null,
      null,
      null,
      {}
    ) === 0;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const scaled = value / (1024 ** unitIndex);
    const decimals = unitIndex === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${scaled.toFixed(decimals)} ${units[unitIndex]}`;
  }

  function bindDataActions() {
    const translationsButton = document.getElementById("papertranslate-clear-translations");
    const allDataButton = document.getElementById("papertranslate-clear-all-data");
    const usage = document.getElementById("papertranslate-storage-usage");
    const refreshButton = document.getElementById("papertranslate-refresh-storage-usage");
    const status = document.getElementById("papertranslate-clear-data-status");
    if (!translationsButton || !allDataButton || !usage || !refreshButton || !status) return;

    const setStatus = (text, state = "") => {
      status.textContent = text;
      status.style.color = state === "success"
        ? "#2e7d32"
        : state === "error"
          ? "#c62828"
          : "";
    };
    const refreshUsage = async () => {
      if (!getPaperTranslateStorageUsage) {
        usage.textContent = "无法计算";
        return;
      }
      refreshButton.disabled = true;
      usage.textContent = "计算中…";
      try {
        const result = await getPaperTranslateStorageUsage();
        usage.textContent = `${formatBytes(result.bytes)}（${result.papers} 篇论文）`;
      } catch (error) {
        usage.textContent = "计算失败";
        Cu.reportError(error);
      } finally {
        refreshButton.disabled = false;
      }
    };
    const run = async (action, successMessage) => {
      translationsButton.disabled = true;
      allDataButton.disabled = true;
      setStatus("清除中…");
      try {
        const result = await action();
        setStatus(successMessage(result), "success");
        await refreshUsage();
      } catch (error) {
        setStatus(error.message || String(error), "error");
      } finally {
        translationsButton.disabled = false;
        allDataButton.disabled = false;
      }
    };

    refreshButton.addEventListener("click", () => {
      void refreshUsage();
    });
    translationsButton.addEventListener("click", () => {
      if (!clearAllTranslationCaches) {
        setStatus("存储模块加载失败，请重启 Zotero 后重试。", "error");
        return;
      }
      if (!confirmClearData({
        title: "清除所有翻译缓存？",
        text: [
          "将删除所有论文的译文缓存，下次翻译时会重新调用大模型生成。",
          "请先结束正在进行的翻译并关闭 Reader 面板。此操作无法撤销。"
        ].join("\n\n"),
        buttonLabel: "清除翻译缓存"
      })) return;
      void run(
        clearAllTranslationCaches,
        ({ removed }) => removed
          ? `已清除 ${removed} 个翻译缓存文件。`
          : "没有可清除的翻译缓存。"
      );
    });

    allDataButton.addEventListener("click", () => {
      if (!clearAllPaperTranslateData) {
        setStatus("存储模块加载失败，请重启 Zotero 后重试。", "error");
        return;
      }
      if (!confirmClearData({
        title: "清除所有解析和翻译缓存？",
        text: [
          "将删除全部 MinerU 解析产物、译文、目录增强缓存和原文编辑。",
          "Zotero 条目与原始 PDF 不会被删除。请先结束正在进行的解析或翻译并关闭 Reader 面板。此操作无法撤销。"
        ].join("\n\n"),
        buttonLabel: "全部清除"
      })) return;
      void run(
        clearAllPaperTranslateData,
        ({ removed }) => removed
          ? "已清除全部解析和翻译缓存。"
          : "没有可清除的解析或翻译缓存。"
      );
    });
    void refreshUsage();
  }

  function init() {
    const root = document.getElementById("papertranslate-preferences-llm-title")?.closest("vbox");
    if (root?.getAttribute("data-papertranslate-initialized") === "true") return;
    root?.setAttribute("data-papertranslate-initialized", "true");

    bindLlmProviderSections();
    bindDataActions();
    bindTest(
      "papertranslate-test-llm",
      "papertranslate-test-llm-status",
      testLlmSettings && getConfig ? () => testLlmSettings(llmConfigFromForm()) : null
    );
    bindTest(
      "papertranslate-test-mineru",
      "papertranslate-test-mineru-status",
      testMineruSettings ? () => testMineruSettings(getConfig().mineru) : null
    );
  }

  function initWhenPaneIsInserted() {
    if (document.getElementById("papertranslate-preferences-llm-provider")) {
      init();
      return;
    }
    // Zotero 会先执行 pane script，再把 preference XHTML fragment 插入文档。
    // 监听 fragment 插入作为根节点 onload 之外的兜底，避免脚本在控件出现前初始化。
    const observer = new MutationObserver(() => {
      if (!document.getElementById("papertranslate-preferences-llm-provider")) return;
      observer.disconnect();
      init();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  initWhenPaneIsInserted();
  return { init };
})();
