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

export const PaperTranslate = {
  _prefPaneID: null,

  startup({ id, version, rootURI, zotero }) {
    ctx.Zotero = zotero;
    ctx.pluginID = id;
    ctx.version = version;
    ctx.rootURI = rootURI;
    ctx.shuttingDown = false;

    // KaTeX 直接在插件模块中把 LaTeX 转为 HTML，避免跨 Reader iframe
    // 调用 MathJax 时的 compartment / structured-clone 问题。
    try {
      const vendor = {};
      Services.scriptloader.loadSubScript(rootURI + "chrome/content/vendor/katex/katex.min.js", vendor);
      ctx.katex = vendor.katex || null;
      if (!ctx.katex?.renderToString) throw new Error("KaTeX 加载失败");
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
