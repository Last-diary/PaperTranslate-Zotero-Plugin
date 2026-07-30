import { getConfig } from "./config.mjs";
import { ctx } from "./context.mjs";
import { MineruClient, uploadToOss } from "./mineru.mjs";
import * as storage from "./storage.mjs";
import {
  canReparseBlock,
  replacementTextFromMineru
} from "./ui/blockReparseText.mjs";
import { randId } from "./utils.mjs";
import { extractZip } from "./zip.mjs";

export { canReparseBlock, replacementTextFromMineru };

async function findContentList(dir, depth = 0) {
  if (depth > 5) return "";
  const children = await IOUtils.getChildren(dir).catch(() => []);
  const exact = children.find((path) => PathUtils.filename(path) === "content_list.json");
  if (exact) return exact;
  const legacy = children.find((path) => PathUtils.filename(path).endsWith("_content_list.json"));
  if (legacy) return legacy;
  for (const child of children) {
    try {
      if ((await IOUtils.stat(child)).type !== "directory") continue;
    } catch {
      continue;
    }
    const nested = await findContentList(child, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function assertActive(shouldAbort) {
  if (ctx.shuttingDown || shouldAbort()) {
    throw new Error("操作已取消。");
  }
}

export async function reparseBlockImage({
  attachment,
  block,
  pngBytes,
  onProgress = () => {},
  shouldAbort = () => false
} = {}) {
  if (!canReparseBlock(block)) {
    throw new Error("当前块类型不支持重新解析。");
  }
  if (!(pngBytes instanceof Uint8Array) || !pngBytes.byteLength) {
    throw new Error("没有生成可上传的块图片。");
  }

  const config = getConfig();
  const mineru = new MineruClient(config);
  const identity = `${attachment?.key || "paper"}-${block.id}`.slice(0, 96);
  const uploadName = `papertranslate-${identity}.png`;

  assertActive(shouldAbort);
  onProgress("申请 MinerU 上传链接…");
  const upload = await mineru.createUploadBatch({ name: uploadName, dataId: identity });
  const batchId = upload.batch_id;
  const uploadUrl = Array.isArray(upload.file_urls) ? upload.file_urls[0] : "";
  if (!batchId || !uploadUrl) throw new Error("MinerU 未返回上传链接。");

  assertActive(shouldAbort);
  onProgress("上传当前块图片到 MinerU…");
  await uploadToOss(uploadUrl, pngBytes);

  onProgress("MinerU 正在重新解析当前块…");
  const result = await mineru.pollBatch(
    batchId,
    uploadName,
    () => ctx.shuttingDown || shouldAbort()
  );
  if (!result.full_zip_url) throw new Error("MinerU 未返回解析结果 ZIP。");

  assertActive(shouldAbort);
  onProgress("下载并读取重新解析结果…");
  const response = await fetch(result.full_zip_url);
  if (!response.ok) throw new Error(`下载解析结果失败：${response.status}`);
  const zipBytes = new Uint8Array(await response.arrayBuffer());

  const tmpDir = PathUtils.join(
    storage.rootDir(),
    "tmp",
    `block-reparse-${attachment?.key || "paper"}-${randId()}`
  );
  const zipPath = PathUtils.join(tmpDir, "result.zip");
  const outputDir = PathUtils.join(tmpDir, "output");
  try {
    await IOUtils.makeDirectory(tmpDir, { createAncestors: true });
    await IOUtils.write(zipPath, zipBytes);
    await extractZip(zipPath, outputDir);
    const contentPath = await findContentList(outputDir);
    if (!contentPath) throw new Error("MinerU 结果中没有 content_list.json。");
    const parsedBlocks = await storage.readJson(contentPath, []);
    const text = replacementTextFromMineru(block, parsedBlocks);
    if (!text) throw new Error("MinerU 没有识别出可替换的文本内容。");
    return text;
  } finally {
    await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true }).catch(() => {});
  }
}
