// 条目右键菜单：Zotero 8+ 用官方 MenuManager API，Zotero 7 回退到 DOM 注入。

import { ctx } from "../context.mjs";
import {
  attachmentDisplayTitle,
  resolvePdfAttachment,
  parseAttachment,
  parseAndTranslateAttachment,
  clearAttachmentsTranslationCaches,
  clearAttachmentsPaperTranslateData
} from "./actions.mjs";

const menuIDs = [];
const fallbackMenus = new Map();
let officialMenusRegistered = false;

function selectedItems(context = null) {
  if (Array.isArray(context?.items)) return context.items;
  const zoteroPane = ctx.Zotero.getActiveZoteroPane?.();
  return zoteroPane?.getSelectedItems?.() || [];
}

function selectedPdfAttachment(context = null) {
  return selectedPdfAttachments(context)[0] || null;
}

function selectedPdfAttachments(context = null) {
  const attachments = [];
  const seen = new Set();
  for (const item of selectedItems(context)) {
    const attachment = resolvePdfAttachment(item);
    if (!attachment) continue;
    const identity = attachment.id
      ? `id:${attachment.id}`
      : `key:${attachment.libraryID || ""}:${attachment.key || ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    attachments.push(attachment);
  }
  return attachments;
}

function confirmClearAttachment({ title, text, buttonLabel }) {
  const prompt = Services.prompt;
  const buttonFlags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING
    + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL
    + prompt.BUTTON_POS_1_DEFAULT;
  return prompt.confirmEx(
    ctx.Zotero.getMainWindow?.() || null,
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

const COMMANDS = {
  parse(event, context) {
    const attachment = selectedPdfAttachment(context);
    if (attachment) parseAttachment(attachment);
  },
  parseAndTranslate(event, context) {
    const attachment = selectedPdfAttachment(context);
    if (attachment) parseAndTranslateAttachment(attachment);
  },
  clearTranslationCache(event, context) {
    const attachments = selectedPdfAttachments(context);
    if (!attachments.length) return;
    const single = attachments.length === 1;
    const targetDescription = single
      ? `“${attachmentDisplayTitle(attachments[0])}”`
      : `选中的 ${attachments.length} 篇论文`;
    if (!confirmClearAttachment({
      title: single
        ? "删除当前论文的翻译缓存？"
        : `删除 ${attachments.length} 篇论文的翻译缓存？`,
      text: [
        `将删除${targetDescription}的全部译文缓存，下次翻译时会重新调用大模型生成。`,
        "请先结束正在进行的翻译并关闭相关论文的 Reader 面板。此操作无法撤销。"
      ].join("\n\n"),
      buttonLabel: "删除翻译缓存"
    })) return;
    void clearAttachmentsTranslationCaches(attachments);
  },
  clearAllCaches(event, context) {
    const attachments = selectedPdfAttachments(context);
    if (!attachments.length) return;
    const single = attachments.length === 1;
    const targetDescription = single
      ? `“${attachmentDisplayTitle(attachments[0])}”`
      : `选中的 ${attachments.length} 篇论文`;
    if (!confirmClearAttachment({
      title: single
        ? "删除当前论文的解析和翻译缓存？"
        : `删除 ${attachments.length} 篇论文的解析和翻译缓存？`,
      text: [
        `将删除${targetDescription}的全部 MinerU 解析产物、译文、目录增强缓存和原文编辑。`,
        "Zotero 条目与原始 PDF 不会被删除。请先结束正在进行的解析或翻译并关闭相关论文的 Reader 面板。此操作无法撤销。"
      ].join("\n\n"),
      buttonLabel: "全部删除"
    })) return;
    void clearAttachmentsPaperTranslateData(attachments);
  }
};

const MENU_DEFS = [
  {
    l10nID: "papertranslate-menu-parse",
    icon: "icons/parse-16.svg",
    isVisible: (context) => Boolean(selectedPdfAttachment(context)),
    onCommand: COMMANDS.parse
  },
  {
    l10nID: "papertranslate-menu-parse-and-translate",
    icon: "icons/parse-translate-16.svg",
    isVisible: (context) => Boolean(selectedPdfAttachment(context)),
    onCommand: COMMANDS.parseAndTranslate
  },
  {
    l10nID: "papertranslate-menu-delete-translation-cache",
    icon: "icons/delete-translation-cache-16.svg",
    isVisible: (context) => selectedPdfAttachments(context).length > 0,
    onCommand: COMMANDS.clearTranslationCache
  },
  {
    l10nID: "papertranslate-menu-delete-all-caches",
    icon: "icons/delete-all-caches-16.svg",
    isVisible: (context) => selectedPdfAttachments(context).length > 0,
    onCommand: COMMANDS.clearAllCaches
  }
];

// 返回 false 表示当前 Zotero 版本需要 DOM 注入回退
export function registerMenus(pluginID) {
  const menuManager = ctx.Zotero.MenuManager;
  if (!menuManager?.registerMenu) return false;

  try {
    const id = menuManager.registerMenu({
      menuID: "papertranslate",
      pluginID,
      target: "main/library/item",
      // main/library/item 会由 Zotero 自动分组，顶层只能放菜单项，
      // 不能插入 separator，否则官方接口会拒绝整组菜单。
      menus: MENU_DEFS.map(({ l10nID, icon, isVisible, onCommand }) => ({
        menuType: "menuitem",
        l10nID,
        ...(icon ? { icon: ctx.rootURI + icon } : {}),
        onShowing: (event, context) => context.setVisible(isVisible(context)),
        onCommand
      }))
    });
    if (!id) {
      throw new Error("Zotero MenuManager 拒绝了 PaperTranslate 条目菜单配置。");
    }
    menuIDs.push(id);
    officialMenusRegistered = true;
    return true;
  } catch (error) {
    officialMenusRegistered = false;
    ctx.Zotero.logError(error);
    return false;
  }
}

export function installFallbackMenu(window) {
  if (officialMenusRegistered) return;
  if (!window || fallbackMenus.has(window)) return;

  const doc = window.document;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup) return;

  const entries = [];
  const groupSeparator = doc.createXULElement("menuseparator");
  popup.appendChild(groupSeparator);

  for (const { l10nID, icon, isVisible, onCommand } of MENU_DEFS) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("data-l10n-id", l10nID);
    if (icon) {
      item.setAttribute("image", ctx.rootURI + icon);
      item.classList.add("menuitem-iconic");
    }
    item.classList.add("papertranslate-menuitem");
    if (onCommand) item.addEventListener("command", onCommand);
    popup.appendChild(item);
    entries.push({ node: item, isVisible });
  }

  const onShowing = () => {
    let anyVisible = false;
    for (const { node, isVisible } of entries) {
      const visible = isVisible(null);
      node.hidden = !visible;
      if (node.localName === "menuitem" && visible) anyVisible = true;
    }
    groupSeparator.hidden = !anyVisible;
  };
  popup.addEventListener("popupshowing", onShowing);
  fallbackMenus.set(window, {
    popup,
    nodes: [groupSeparator, ...entries.map(({ node }) => node)],
    onShowing
  });
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
  officialMenusRegistered = false;
  for (const window of [...fallbackMenus.keys()]) removeFallbackMenus(window);
}
