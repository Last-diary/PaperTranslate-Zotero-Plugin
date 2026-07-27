/* global Zotero, Cc, Ci, Services, ChromeUtils */

var chromeHandle;

function startup({ id, version, rootURI }, reason) {
  try {
    // 运行时注册 chrome，使 importESModule 可以加载插件内的 .mjs 模块
    var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "papertranslate", "chrome/content/"]
    ]);

    var { PaperTranslate } = ChromeUtils.importESModule("chrome://papertranslate/content/modules/main.mjs");

    Zotero.PaperTranslate = PaperTranslate;
    PaperTranslate.startup({ id, version, rootURI, zotero: Zotero }, reason);
    Zotero.debug("PaperTranslate: startup OK");
  } catch (error) {
    Zotero.logError(error);
  }
}

function shutdown(data, reason) {
  if (Zotero.PaperTranslate) {
    try {
      Zotero.PaperTranslate.shutdown();
    } catch (error) {
      Zotero.logError(error);
    }
    delete Zotero.PaperTranslate;
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function install(data, reason) {}

function uninstall(data, reason) {}

function onMainWindowLoad({ window }) {
  Zotero.PaperTranslate?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  Zotero.PaperTranslate?.onMainWindowUnload(window);
}
