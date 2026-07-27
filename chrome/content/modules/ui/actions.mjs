// 共享动作：菜单、条目面板、阅读面板都通过这里触发解析/翻译/打开。

import { ctx } from "../context.mjs";
import { importAttachment } from "../importer.mjs";
import { TranslationService } from "../deepseek.mjs";
import { loadBlocks } from "../blocks.mjs";
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

export async function parseAttachment(attachment) {
  return runWithProgress("PaperTranslate 解析 PDF", async (update) => {
    const { manifest } = await importAttachment(attachment, { onProgress: update });
    return `解析完成：${manifest.title}`;
  });
}

export async function translateAttachment(attachment, { force = false } = {}) {
  return runWithProgress("PaperTranslate 翻译全文", async (update) => {
    const dir = storage.itemDir(attachment);
    const manifest = await storage.readManifest(attachment);
    if (!manifest) throw new Error("尚未解析，请先执行“用 MinerU 解析 PDF”。");
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

export async function openInReader(attachment) {
  await ctx.Zotero.Reader.open(attachment.id);
}
