// 插件主入口：bootstrap.js 通过 importESModule 加载本模块并转发生命周期钩子。

import { ctx } from "./context.mjs";
import {
  registerMenus,
  installFallbackMenu,
  removeFallbackMenus,
  unregisterMenus
} from "./ui/menu.mjs";
import { registerItemPane } from "./ui/itemPane.mjs";
import { registerReader } from "./ui/readerPanel.mjs";

const PREFERENCE_PANE_ID = "papertranslate-preferences";

function loadSandboxedUMD(uri, globalName, sandboxName) {
  // Zotero 的 privileged compartment 会给 loadSubScript({}, ...) 的复杂
  // UMD 导出套 Xray wrapper，Marked/DOMPurify 的属性因此不可见。使用独立
  // system-principal sandbox 并显式 waiveXrays，把私有访问集中在这里。
  const sandbox = Cu.Sandbox(
    Services.scriptSecurityManager.getSystemPrincipal(),
    {
      sandboxName,
      wantXrays: false
    }
  );
  try {
    Services.scriptloader.loadSubScript(uri, sandbox, "UTF-8");
    const exported = Cu.waiveXrays(sandbox[globalName]);
    if (!exported) throw new Error(`${globalName} UMD 导出不存在`);
    return { exported, sandbox };
  } catch (error) {
    Cu.nukeSandbox(sandbox);
    throw error;
  }
}

export const PaperTranslate = {
  _prefPaneID: null,

  startup({ id, version, rootURI, zotero }) {
    ctx.Zotero = zotero;
    ctx.pluginID = id;
    ctx.version = version;
    ctx.rootURI = rootURI;
    ctx.shuttingDown = false;

    // 渲染依赖全部随 XPI 本地打包。脚本先加载到独立对象；
    // DOMPurify 只保留工厂函数，Reader 面板会用自己的 window 创建实例。
    try {
      const katexVendor = {};
      Services.scriptloader.loadSubScript(
        rootURI + "chrome/content/vendor/katex/katex.min.js",
        katexVendor
      );
      ctx.katex = katexVendor.katex || null;
      if (!ctx.katex?.renderToString) throw new Error("KaTeX 加载失败");

      const markedVendor = loadSandboxedUMD(
        rootURI + "chrome/content/vendor/marked/marked.umd.js",
        "marked",
        "PaperTranslate Marked 18"
      );
      ctx.marked = markedVendor.exported;
      ctx.vendorSandboxes.push(markedVendor.sandbox);
      if (!ctx.marked?.Marked || !ctx.marked?.parse) {
        throw new Error("Marked 18 加载失败");
      }

      const purifyVendor = loadSandboxedUMD(
        rootURI + "chrome/content/vendor/dompurify/purify.min.js",
        "DOMPurify",
        "PaperTranslate DOMPurify 3.4.12"
      );
      ctx.createDOMPurify = purifyVendor.exported;
      ctx.vendorSandboxes.push(purifyVendor.sandbox);
      if (typeof ctx.createDOMPurify !== "function") {
        throw new Error("DOMPurify 3.4.12 加载失败");
      }
    } catch (error) {
      zotero.logError(error);
    }

    // 设置页（Zotero 7+ 官方 API）
    try {
      this._prefPaneID = PREFERENCE_PANE_ID;
      zotero.PreferencePanes.register({
        pluginID: id,
        id: this._prefPaneID,
        label: "PaperTranslate",
        src: "chrome/content/preferences.xhtml",
        scripts: ["chrome/content/preferences.js"]
      }).catch((error) => zotero.logError(error));
    } catch (error) {
      zotero.logError(error);
    }

    registerMenus(id);
    registerItemPane(id, rootURI);
    registerReader(id);

    // 处理已经打开的主窗口：插件在 Zotero 运行中被启用时，
    // onMainWindowLoad 不会为现存窗口补发，需要主动执行一遍。
    for (const win of zotero.getMainWindows?.() || []) {
      try {
        this.onMainWindowLoad(win);
      } catch (error) {
        zotero.logError(error);
      }
    }
  },

  shutdown() {
    ctx.shuttingDown = true;

    try {
      unregisterMenus();
    } catch (error) {
      ctx.Zotero?.logError(error);
    }

    // ItemPaneManager / Reader 事件监听按 pluginID 自动移除
    try {
      if (this._prefPaneID && ctx.Zotero?.PreferencePanes?.unregister) {
        ctx.Zotero.PreferencePanes.unregister(this._prefPaneID);
      }
    } catch (error) {
      ctx.Zotero?.logError(error);
    }
    this._prefPaneID = null;
    ctx.katex = null;
    ctx.marked = null;
    ctx.createDOMPurify = null;
    for (const sandbox of ctx.vendorSandboxes.splice(0)) {
      try {
        Cu.nukeSandbox(sandbox);
      } catch (error) {
        ctx.Zotero?.logError(error);
      }
    }
  },

  onMainWindowLoad(window) {
    // 让菜单/面板的 data-l10n-id 能解析到插件的 Fluent 字符串
    try {
      window.MozXULElement?.insertFTLIfNeeded("papertranslate.ftl");
    } catch {}
    installFallbackMenu(window);
  },

  onMainWindowUnload(window) {
    removeFallbackMenus(window);
  }
};
