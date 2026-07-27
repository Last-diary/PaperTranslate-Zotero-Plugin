// 导入管线（移植自原项目 server/importer.js）
// 流程：Zotero PDF 附件 → MinerU 上传/轮询 → 下载 ZIP → 解压到条目数据目录 → 写 parser-manifest.json

import { ctx } from "./context.mjs";
import { getConfig } from "./config.mjs";
import { MineruClient, uploadToOss } from "./mineru.mjs";
import { extractZip } from "./zip.mjs";
import * as storage from "./storage.mjs";
import { safeName, cleanTitle, randId } from "./utils.mjs";
import { contentBlockText } from "./blocks.mjs";

const SOURCE_PDF_NAME = "source.pdf";

async function findMineruOutputRoot(dir, depth = 0) {
  if (depth > 5) return null;
  const children = await IOUtils.getChildren(dir).catch(() => []);
  const names = children.map((p) => PathUtils.filename(p));
  if (names.includes("full.md") || names.some((name) => name.endsWith("_content_list.json")) || names.includes("block_list.json")) {
    return dir;
  }
  for (const child of children) {
    let isDirectory = false;
    try {
      isDirectory = (await IOUtils.stat(child)).type === "directory";
    } catch {
      continue;
    }
    if (isDirectory) {
      const found = await findMineruOutputRoot(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function moveChildrenUp(fromDir, toDir) {
  const children = await IOUtils.getChildren(fromDir).catch(() => []);
  for (const from of children) {
    const name = PathUtils.filename(from);
    let to = PathUtils.join(toDir, name);
    if (from === to) continue;
    if (await IOUtils.exists(to)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      to = PathUtils.join(toDir, `${stem}-${randId()}${ext}`);
    }
    await IOUtils.move(from, to);
  }
}

// MinerU ZIP 可能多套一层目录，把真正的产物目录内容上提到根
async function normalizeExtractedProject(projectDir) {
  const outputRoot = await findMineruOutputRoot(projectDir);
  if (outputRoot && outputRoot !== projectDir) {
    await moveChildrenUp(outputRoot, projectDir);
  }
}

export async function importAttachment(item, { onProgress = () => {} } = {}) {
  const config = getConfig();
  if (!config.mineru.apiKey) {
    throw new Error("请先在 设置 → PaperTranslate 中填写 MinerU API Token。");
  }
  const mineru = new MineruClient(config);

  const filePath = await item.getFilePathAsync();
  if (!filePath) throw new Error("附件文件不在本地，请先在 Zotero 中下载该附件。");

  const fileName = item.attachmentFilename || "paper.pdf";
  const baseName = safeName(fileName.replace(/\.pdf$/i, "")) || "paper";
  const dataId = baseName.slice(0, 96) || `paper-${Date.now()}`;
  const uploadName = `${baseName}.pdf`;

  onProgress("申请 MinerU 上传链接…");
  const upload = await mineru.createUploadBatch({ name: uploadName, dataId });
  const batchId = upload.batch_id;
  const uploadUrl = Array.isArray(upload.file_urls) ? upload.file_urls[0] : "";
  if (!batchId || !uploadUrl) throw new Error("MinerU 未返回上传链接。");

  onProgress("上传 PDF 到 MinerU…");
  const buffer = await IOUtils.read(filePath);
  await uploadToOss(uploadUrl, buffer);

  onProgress("MinerU 解析中（通常需要 1-3 分钟）…");
  const result = await mineru.pollBatch(batchId, uploadName, () => ctx.shuttingDown);
  if (!result.full_zip_url) throw new Error("MinerU 未返回解析结果 ZIP。");

  onProgress("下载解析结果…");
  const response = await fetch(result.full_zip_url);
  if (!response.ok) throw new Error(`下载解析结果失败：${response.status}`);
  const zipBuffer = new Uint8Array(await response.arrayBuffer());

  const tmpDir = PathUtils.join(storage.rootDir(), "tmp");
  await IOUtils.makeDirectory(tmpDir, { createAncestors: true });
  const zipPath = PathUtils.join(tmpDir, `${item.key}-${randId()}.zip`);
  await IOUtils.write(zipPath, zipBuffer);

  onProgress("解压并整理解析产物…");
  const dir = storage.itemDir(item);
  await storage.removeItemData(dir);
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  try {
    await extractZip(zipPath, dir);
  } finally {
    await IOUtils.remove(zipPath, { ignoreAbsent: true });
  }
  await normalizeExtractedProject(dir);

  // 保存一份原始 PDF（MinerU 产物中的 _origin.pdf 可能被二次编码）
  const sourcePdfPath = PathUtils.join(dir, SOURCE_PDF_NAME);
  await IOUtils.remove(sourcePdfPath, { ignoreAbsent: true });
  await IOUtils.copy(filePath, sourcePdfPath);

  // 识别产物文件
  const children = await IOUtils.getChildren(dir).catch(() => []);
  const names = children.map((p) => PathUtils.filename(p));
  const contentList = names.includes("content_list.json")
    ? "content_list.json"
    : names.find((name) => name.endsWith("_content_list.json")) || "";
  const displayPdf = names.find((name) => name.endsWith("_origin.pdf"))
    || names.find((name) => name.toLowerCase().endsWith(".pdf") && name !== SOURCE_PDF_NAME)
    || "";

  // 概要信息（标题 / 块数 / 页数）
  let title = "";
  let blockCount = null;
  let pageCount = null;
  if (contentList) {
    const data = await storage.readJson(PathUtils.join(dir, contentList), []);
    if (Array.isArray(data) && data.length) {
      const titleBlock = data.find((block) => block.type === "title" && contentBlockText(block))
        || data.find((block) => contentBlockText(block));
      title = cleanTitle(contentBlockText(titleBlock), "");
      blockCount = data.length;
      const pages = data.map((block) => Number(block.page_idx)).filter((page) => Number.isFinite(page));
      pageCount = pages.length ? Math.max(...pages) + 1 : null;
    }
  }

  const manifest = {
    version: 1,
    attachmentKey: item.key,
    // MinerU 偶尔会把首页版权或授权声明误标为 title。Zotero 条目标题
    // 由用户元数据确定，可靠性更高，因此优先写入解析清单。
    title: cleanTitle(
      (item.parentItemID
        ? ctx.Zotero.Items.get(item.parentItemID)?.getField?.("title")
        : item.getField?.("title")),
      ""
    ) || title || fileName.replace(/\.pdf$/i, ""),
    fileName,
    provider: "mineru",
    model: config.mineru.modelVersion,
    createdAt: new Date().toISOString(),
    files: {
      contentList,
      displayPdf,
      sourcePdf: SOURCE_PDF_NAME
    },
    blockCount,
    pageCount
  };
  await storage.writeJson(storage.manifestPath(dir), manifest);
  return { dir, manifest };
}
