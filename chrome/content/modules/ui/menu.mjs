// 条目右键菜单：Zotero 8+ 用官方 MenuManager API，Zotero 7 回退到 DOM 注入。

import { ctx } from "../context.mjs";
import { resolveFromSelection, parseAttachment, translateAttachment, openInReader } from "./actions.mjs";

const menuIDs = [];
const fallbackMenus = new Map();

function selectedPdfAttachment() {
  const zoteroPane = ctx.Zotero.getActiveZoteroPane?.();
  return resolveFromSelection(zoteroPane?.getSelectedItems?.() || []);
}

const COMMANDS = {
  parse() {
    const attachment = selectedPdfAttachment();
    if (attachment) parseAttachment(attachment);
  },
  translate() {
    const attachment = selectedPdfAttachment();
    if (attachment) translateAttachment(attachment);
  },
  open() {
    const attachment = selectedPdfAttachment();
    if (attachment) openInReader(attachment);
  }
};

const MENU_DEFS = [
  ["papertranslate-menu-parse", COMMANDS.parse],
  ["papertranslate-menu-translate", COMMANDS.translate],
  ["papertranslate-menu-open", COMMANDS.open]
];

// 返回 false 表示当前 Zotero 版本需要 DOM 注入回退
export function registerMenus(pluginID) {
  const menuManager = ctx.Zotero.MenuManager;
  if (!menuManager?.registerMenu) return false;

  menuIDs.push(menuManager.registerMenu({
    menuID: "papertranslate",
    pluginID,
    target: "main/library/item",
    menus: MENU_DEFS.map(([l10nID, onCommand]) => ({
      menuType: "menuitem",
      l10nID,
      onShowing: (event, context) => context.setVisible(Boolean(selectedPdfAttachment())),
      onCommand
    }))
  }));
  return true;
}

export function installFallbackMenu(window) {
  if (ctx.Zotero.MenuManager?.registerMenu) return;
  if (!window || fallbackMenus.has(window)) return;

  const doc = window.document;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup) return;

  const nodes = [];
  const separator = doc.createXULElement("menuseparator");
  popup.appendChild(separator);
  nodes.push(separator);

  for (const [l10nId, handler] of MENU_DEFS) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("data-l10n-id", l10nId);
    item.classList.add("papertranslate-menuitem");
    item.addEventListener("command", handler);
    popup.appendChild(item);
    nodes.push(item);
  }

  const onShowing = () => {
    const visible = Boolean(selectedPdfAttachment());
    for (const node of nodes) node.hidden = !visible;
  };
  popup.addEventListener("popupshowing", onShowing);
  fallbackMenus.set(window, { popup, nodes, onShowing });
}

export function removeFallbackMenus(window) {
  const entry = fallbackMenus.get(window);
  if (!entry) return;
  entry.popup.removeEventListener("popupshowing", entry.onShowing);
  for (const node of entry.nodes) node.remove();
  fallbackMenus.delete(window);
}

export function unregisterMenus() {
  for (const id of menuIDs.splice(0)) {
    try {
      ctx.Zotero.MenuManager?.unregisterMenu(id);
    } catch {}
  }
  for (const window of [...fallbackMenus.keys()]) removeFallbackMenus(window);
}
