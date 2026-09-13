// 共享动作：菜单、条目面板、阅读面板都通过这里触发解析/翻译/打开。

import { ctx } from "../context.mjs";
import { importAttachment } from "../importer.mjs";
import { TranslationService } from "../deepseek.mjs";
import { loadBlocks } from "../blocks.mjs";
import { runDocumentReparse } from "../documentReparse.mjs";
import * as storage from "../storage.mjs";
import { runWithProgress } from "./progress.mjs";

export function isPdfAttachment(item) {
  if (!item || !item.isAttachment || !item.isAttachment()) return false;
  const contentType = item.attachmentContentType || "";
  const fileName = (item.attachmentFilename || "").toLowerCase();
  return contentType === "application/pdf" || fileName.endsWith(".pdf");
}

// 常规条目 → 第一个 PDF 附件；PDF 附件 → 自身；其他 → null
export function resolvePdfAttachment(item) {
  const { Zotero } = ctx;
  if (!item) return null;
  if (isPdfAttachment(item)) return item;
  if (item.isRegularItem && item.isRegularItem()) {
    for (const id of item.getAttachments() || []) {
      const attachment = Zotero.Items.get(id);
      if (isPdfAttachment(attachment)) return attachment;
    }
  }
  return null;
}

export function resolveFromSelection(items) {
  for (const item of items || []) {
    const attachment = resolvePdfAttachment(item);
    if (attachment) return attachment;
  }
  return null;
}

export function attachmentDisplayTitle(attachment, manifest = null, maxLength = 88) {
  let parentTitle = "";
  let attachmentTitle = "";
  try {
    parentTitle = attachment?.parentItemID
      ? ctx.Zotero.Items.get(attachment.parentItemID)?.getField?.("title") || ""
      : "";
    attachmentTitle = attachment?.getField?.("title") || "";
  } catch {}
  const title = String(
    parentTitle
      || attachmentTitle
      || manifest?.title
      || attachment?.attachmentFilename
      || "PDF"
  ).replace(/\s+/g, " ").trim();
  return title.length > maxLength
    ? `${title.slice(0, Math.max(1, maxLength - 1))}…`
    : title;
}

async function existingParsedAttachment(attachment) {
  const dir = storage.itemDir(attachment);
  const manifest = await storage.readManifest(attachment);
  if (!manifest) return null;
  const blocks = await loadBlocks(dir, manifest);
  return blocks.length ? { dir, manifest, blocks } : null;
}

export async function parseAttachment(attachment, { force = false } = {}) {
  return runWithProgress("PDF 解析", async (update) => {
    update("检查已有解析结果…");
    if (!force) {
      const existing = await existingParsedAttachment(attachment);
      if (existing) {
        return "解析结果已存在，已跳过重复解析。";
      }
    }
    await importAttachment(attachment, { onProgress: update });
    return "解析完成。";
  });
}

export async function translateAttachment(attachment, { force = false } = {}) {
  return runWithProgress("全文翻译", async (update) => {
    const dir = storage.itemDir(attachment);
    const manifest = await storage.readManifest(attachment);
    if (!manifest) throw new Error("尚未解析，请先执行“解析 PDF”。");
    const blocks = await loadBlocks(dir, manifest);
    if (!blocks.length) throw new Error("没有可翻译的内容块。");

    const service = new TranslationService();
    const result = await service.translateBlocks({
      dir,
      allBlocks: blocks,
      force,
      onChunk: (cache, done, total) => update(`翻译中… ${done}/${total} 段`)
    });
    return `翻译完成，本次 ${result.translated} 段，缓存共 ${Object.keys(result.translations).length} 段。`;
  });
}

export async function parseAndTranslateAttachment(attachment, { force = false } = {}) {
  return runWithProgress("解析并翻译", async (update) => {
    update("检查已有解析结果…");
    let project = await existingParsedAttachment(attachment);
    const reusedParsing = Boolean(project);
    if (project) {
      update("解析结果已存在，跳过重复解析并检查译文…");
    } else {
      const { dir, manifest } = await importAttachment(attachment, {
        onProgress: (text) => update(`解析：${text}`)
      });
      const blocks = await loadBlocks(dir, manifest);
      project = { dir, manifest, blocks };
      update("解析完成，准备翻译全文…");
    }

    const { dir, blocks } = project;
    if (!blocks.length) throw new Error("解析完成，但没有可翻译的内容块。");

    const service = new TranslationService();
    const result = await service.translateBlocks({
      dir,
      allBlocks: blocks,
      force,
      onChunk: (cache, done, total) => update(`翻译中… ${done}/${total} 段`)
    });
    if (!result.translated) {
      return reusedParsing
        ? "解析结果已存在，没有需要新增翻译的内容。"
        : "解析完成，没有需要翻译的内容。";
    }
    return `解析并翻译完成：本次翻译 ${result.translated} 段。`;
  });
}

export async function reparseDocumentBlocks(attachment, { restart = false } = {}) {
  return runWithProgress("强制重解析全部块", async (update) => {
    const result = await runDocumentReparse(attachment, {
      restart,
      onProgress: update
    });
    if (!result.submitted && result.priorSucceeded) {
      return `已有 ${result.priorSucceeded} 个块成功完成，没有未完成块。`;
    }
    return [
      `完成：实际消耗 ${result.submitted} 个块`,
      `成功 ${result.success}`,
      `替换 ${result.changed}`,
      `失败 ${result.failed}`,
      `跳过 ${result.skipped}`
    ].join("；");
  });
}

export async function clearAttachmentsTranslationCaches(attachments) {
  const targets = Array.from(attachments || []);
  return runWithProgress("PaperTranslate 删除翻译缓存", async (update) => {
    let removed = 0;
    for (let index = 0; index < targets.length; index++) {
      update(`正在删除翻译缓存… ${index + 1}/${targets.length} 篇`);
      const result = await storage.clearItemTranslationCache(targets[index]);
      if (result.removed) removed++;
    }
    if (targets.length === 1) {
      return removed
        ? "已删除翻译缓存。"
        : "没有可删除的翻译缓存。";
    }
    return removed
      ? `已删除 ${removed} 篇论文的翻译缓存；${targets.length - removed} 篇没有翻译缓存。`
      : `选中的 ${targets.length} 篇论文都没有可删除的翻译缓存。`;
  });
}

export async function clearAttachmentsPaperTranslateData(attachments) {
  const targets = Array.from(attachments || []);
  return runWithProgress("PaperTranslate 删除解析和翻译缓存", async (update) => {
    let removed = 0;
    for (let index = 0; index < targets.length; index++) {
      update(`正在删除解析和翻译缓存… ${index + 1}/${targets.length} 篇`);
      const result = await storage.clearItemPaperTranslateData(targets[index]);
      if (result.removed) removed++;
    }
    if (targets.length === 1) {
      return removed
        ? "已删除解析和翻译缓存。"
        : "没有可删除的解析或翻译缓存。";
    }
    return removed
      ? `已删除 ${removed} 篇论文的解析和翻译缓存；${targets.length - removed} 篇没有相关缓存。`
      : `选中的 ${targets.length} 篇论文都没有可删除的解析或翻译缓存。`;
  });
}

export async function openInReader(attachment) {
  await ctx.Zotero.Reader.open(attachment.id);
}
