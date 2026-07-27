// 设置面板脚本：为“测试”按钮接线。
// 注意：Zotero 9 中每个设置面板脚本运行在独立全局作用域，需自行 import 模块。

(function () {
  let getConfig = null;
  let testDeepSeekSettings = null;
  let testMineruSettings = null;
  try {
    ({ getConfig } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/config.mjs"));
    ({ testDeepSeekSettings } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/deepseek.mjs"));
    ({ testMineruSettings } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/mineru.mjs"));
  } catch (error) {
    Cu.reportError(error);
  }

  function bindTest(buttonId, statusId, run) {
    const button = document.getElementById(buttonId);
    const status = document.getElementById(statusId);
    if (!button || !status) return;
    button.addEventListener("click", async () => {
      if (!run) {
        status.textContent = "模块加载失败，请重启 Zotero 后重试。";
        return;
      }
      status.textContent = "测试中…";
      try {
        const result = await run();
        status.textContent = result.message;
      } catch (error) {
        status.textContent = error.message || String(error);
      }
    });
  }

  function init() {
    bindTest(
      "papertranslate-test-deepseek",
      "papertranslate-test-deepseek-status",
      testDeepSeekSettings ? () => testDeepSeekSettings(getConfig().deepseek) : null
    );
    bindTest(
      "papertranslate-test-mineru",
      "papertranslate-test-mineru-status",
      testMineruSettings ? () => testMineruSettings(getConfig().mineru) : null
    );
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }
})();
