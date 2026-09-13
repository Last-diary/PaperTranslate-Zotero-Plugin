import { openBackgroundBlockRenderer } from "./backgroundBlockRenderer.mjs";
import { replacementTextFromMineruResult } from "./blockReparse.mjs";
import { loadBlocks } from "./blocks.mjs";
import { getConfig } from "./config.mjs";
import { ctx } from "./context.mjs";
import { eligibleTranslationIds } from "./deepseek.mjs";
import { MineruClient, uploadToOss } from "./mineru.mjs";
import {
  isPaperDataBusy,
  notifyPaperDataChanged
} from "./paperDataEvents.mjs";
import * as storage from "./storage.mjs";
import { blockSourceText, setBlockSourceText } from "./ui/blockEditing.mjs";
import {
  chunkDocumentReparseItems,
  documentReparseCampaignKey,
  normalizeDocumentReparseRecord,
  planDocumentReparse,
  recordDocumentReparseResult
} from "./ui/documentReparseState.mjs";
import { randId } from "./utils.mjs";

const IMPLEMENTATION_MARKER = "document-reparse-batch-v2-rate-limit-50";
const activeAttachments = new Set();

function assertActive(attachment, shouldAbort = () => false) {
  if (ctx.shuttingDown || shouldAbort()) throw new Error("操作已取消。");
  if (!attachment?.id || !ctx.Zotero.Items.exists(attachment.id)) {
    throw new Error("PDF 附件已删除，操作已取消。");
  }
}

function sourceOverrideState(data) {
  return {
    overrides: data?.overrides && typeof data.overrides === "object" ? { ...data.overrides } : {},
    pendingIds: new Set(
      Array.isArray(data?.pendingTranslationIds)
        ? data.pendingTranslationIds.filter((id) => typeof id === "string")
        : []
    )
  };
}

function sourceOverridePayload(overrides, pendingIds) {
  return {
    version: 1,
    overrides,
    pendingTranslationIds: [...pendingIds]
  };
}

function applySourceOverrides(blocks, overrides) {
  for (const block of blocks) {
    if (Object.prototype.hasOwnProperty.call(overrides, block.id)) {
      setBlockSourceText(block, overrides[block.id]);
    }
  }
}

async function attachmentProject(attachment) {
  const dir = storage.itemDir(attachment);
  const manifest = await storage.readManifest(attachment);
  if (!manifest) return null;
  const filePath = await attachment.getFilePathAsync();
  if (!filePath) return null;
  const fileInfo = await IOUtils.stat(filePath).catch(() => null);
  if (!fileInfo || fileInfo.type !== "regular") return null;
  const blocks = await loadBlocks(dir, manifest, { hideNonBody: false });
  if (!blocks.length) return null;
  const sourceState = sourceOverrideState(
    await storage.readJson(storage.sourceOverridesPath(dir), {})
  );
  applySourceOverrides(blocks, sourceState.overrides);
  const config = getConfig();
  const campaignKey = documentReparseCampaignKey({
    manifest,
    fileInfo,
    blocks,
    mineru: config.mineru
  });
  const record = normalizeDocumentReparseRecord(
    await storage.readJson(storage.documentReparsePath(dir), null),
    campaignKey
  );
  return {
    attachment,
    dir,
    manifest,
    filePath,
    fileInfo,
    blocks,
    sourceState,
    config,
    campaignKey,
    record
  };
}

export async function getDocumentReparseInfo(attachment) {
  const project = await attachmentProject(attachment);
  if (!project) return null;
  const plan = planDocumentReparse(project.blocks, project.record);
  if (!plan.candidates.length) return null;
  return { ...project, plan };
}

function blockDescriptor(attachment, block) {
  const identity = `${attachment.key}-${block.id}`.slice(0, 120);
  return {
    block,
    name: `papertranslate-${identity}.png`,
    dataId: identity
  };
}

async function renderMissingImages(project, entries, imagePaths, tmpDir, update, shouldAbort) {
  const missing = entries.filter((entry) => !imagePaths.has(entry.block.id));
  if (!missing.length) return [];
  let renderer = null;
  const failures = [];
  try {
    renderer = await openBackgroundBlockRenderer(project.attachment, { shouldAbort });
    for (let index = 0; index < missing.length; index += 1) {
      const entry = missing[index];
      assertActive(project.attachment, shouldAbort);
      update(`后台裁切块… ${index + 1}/${missing.length}`);
      try {
        const bytes = await renderer.render(entry.block);
        const path = PathUtils.join(tmpDir, `${entry.block.id}.png`);
        await IOUtils.write(path, bytes);
        imagePaths.set(entry.block.id, path);
      } catch (error) {
        failures.push({
          block: entry.block,
          success: false,
          error: `裁图失败：${error.message || error}`
        });
      }
      await ctx.Zotero.Promise.delay(0);
    }
  } finally {
    renderer?.close();
  }
  return failures;
}

async function submitBatch(project, entries, imagePaths, mineru, update, shouldAbort, counters) {
  assertActive(project.attachment, shouldAbort);
  const descriptors = entries.filter((entry) => imagePaths.has(entry.block.id));
  if (!descriptors.length) return [];
  update(`申请 MinerU 批量上传链接… ${descriptors.length} 个块`);
  let upload;
  try {
    upload = await mineru.createUploadBatchFiles(descriptors, { shouldAbort, onProgress: update });
  } catch (error) {
    return descriptors.map(({ block }) => ({
      block,
      success: false,
      error: `申请批量任务失败：${error.message || error}`
    }));
  }
  const batchId = upload?.batch_id;
  const urls = Array.isArray(upload?.file_urls) ? upload.file_urls : [];
  if (!batchId || urls.length !== descriptors.length) {
    return descriptors.map(({ block }) => ({
      block,
      success: false,
      error: "MinerU 返回的批量上传链接数量不匹配。"
    }));
  }

  const uploaded = [];
  const outcomes = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const entry = descriptors[index];
    assertActive(project.attachment, shouldAbort);
    update(`上传块到 MinerU… ${index + 1}/${descriptors.length}`);
    try {
      const bytes = await IOUtils.read(imagePaths.get(entry.block.id));
      await uploadToOss(urls[index], bytes);
      uploaded.push(entry);
      counters.submitted += 1;
    } catch (error) {
      outcomes.push({
        block: entry.block,
        success: false,
        error: `上传失败：${error.message || error}`
      });
    }
  }
  if (!uploaded.length) return outcomes;

  update(`MinerU 批量解析中… ${uploaded.length} 个块`);
  let polled;
  try {
    polled = await mineru.pollBatchResults(batchId, uploaded, () => (
      ctx.shuttingDown || shouldAbort()
    ));
  } catch (error) {
    return outcomes.concat(uploaded.map(({ block }) => ({
      block,
      success: false,
      error: `批量轮询失败：${error.message || error}`
    })));
  }

  for (let index = 0; index < polled.length; index += 1) {
    const entry = uploaded[index];
    const result = polled[index]?.result;
    assertActive(project.attachment, shouldAbort);
    update(`读取 MinerU 结果… ${index + 1}/${polled.length}`);
    if (result?.state !== "done" || !result.full_zip_url) {
      outcomes.push({
        block: entry.block,
        success: false,
        error: `MinerU 解析失败：${result?.err_msg || "unknown error"}`
      });
      continue;
    }
    try {
      const replacement = await replacementTextFromMineruResult({
        attachment: project.attachment,
        block: entry.block,
        result,
        shouldAbort
      });
      outcomes.push({ block: entry.block, success: true, replacement });
    } catch (error) {
      outcomes.push({
        block: entry.block,
        success: false,
        error: `读取结果失败：${error.message || error}`
      });
    }
  }
  return outcomes;
}

async function persistOutcomes(project, outcomes, state) {
  // Reader 面板可能在任务确认和附件锁定之间刚完成一次写入。每批提交前
  // 重新合并磁盘状态，避免覆盖不相关块的手工编辑或新译文。
  const latestSourceState = sourceOverrideState(
    await storage.readJson(storage.sourceOverridesPath(project.dir), {})
  );
  state.overrides = latestSourceState.overrides;
  state.pendingIds = latestSourceState.pendingIds;
  state.translations = (
    await storage.readJson(storage.translationsPath(project.dir), {})
  ) || {};
  let nextOverrides = state.overrides;
  let nextPendingIds = state.pendingIds;
  let nextTranslations = state.translations;
  let contentChanged = false;

  for (const outcome of outcomes) {
    if (!outcome.success) continue;
    const changed = outcome.replacement !== blockSourceText(outcome.block);
    outcome.changed = changed;
    if (!changed) continue;
    if (!contentChanged) {
      nextOverrides = { ...state.overrides };
      nextPendingIds = new Set(state.pendingIds);
      nextTranslations = { ...state.translations };
      contentChanged = true;
    }
    nextOverrides[outcome.block.id] = outcome.replacement;
    setBlockSourceText(outcome.block, outcome.replacement);
    if (state.eligibleIds.has(outcome.block.id)) {
      delete nextTranslations[outcome.block.id];
      nextPendingIds.add(outcome.block.id);
    }
  }

  if (contentChanged) {
    await storage.writeJson(storage.translationsPath(project.dir), nextTranslations);
    try {
      await storage.writeJson(
        storage.sourceOverridesPath(project.dir),
        sourceOverridePayload(nextOverrides, nextPendingIds)
      );
    } catch (error) {
      await storage.writeJson(storage.translationsPath(project.dir), state.translations).catch(() => {});
      throw error;
    }
    state.overrides = nextOverrides;
    state.pendingIds = nextPendingIds;
    state.translations = nextTranslations;
  }

  for (const outcome of outcomes) {
    const previousAttempts = Number(state.record.blocks[outcome.block.id]?.attempts) || 0;
    state.record = recordDocumentReparseResult(state.record, outcome.block, {
      success: outcome.success,
      changed: outcome.changed,
      error: outcome.error,
      attempts: previousAttempts + 1
    });
  }
  await storage.writeJson(storage.documentReparsePath(project.dir), state.record);
  return contentChanged;
}

export async function runDocumentReparse(attachment, {
  restart = false,
  onProgress = () => {},
  shouldAbort = () => false
} = {}) {
  if (activeAttachments.has(attachment?.id)) {
    throw new Error("当前论文已经在进行强制重解析。");
  }
  activeAttachments.add(attachment.id);
  let panelLocked = false;
  const tmpDir = PathUtils.join(
    storage.rootDir(),
    "tmp",
    `document-reparse-${attachment.key}-${randId()}`
  );
  try {
    if (isPaperDataBusy({ attachmentID: attachment.id })) {
      throw new Error("当前论文正在翻译或重新解析，请等待任务结束后重试。");
    }
    const project = await attachmentProject(attachment);
    if (!project) throw new Error("当前论文尚未完成解析，或本地 PDF 不可用。");
    if (!project.config.mineru.apiKey) {
      throw new Error("请先在 设置 → PaperTranslate 中填写 MinerU API Token。");
    }
    notifyPaperDataChanged({
      attachmentID: attachment.id,
      reason: "document-reparse-start"
    });
    panelLocked = true;
    if (restart) {
      project.record = normalizeDocumentReparseRecord(null, project.campaignKey);
    }
    const plan = planDocumentReparse(project.blocks, project.record, { restart });
    if (!plan.targets.length) return {
      submitted: 0,
      success: plan.priorSucceeded,
      changed: 0,
      failed: 0,
      skipped: plan.skipped.length,
      priorSucceeded: plan.priorSucceeded
    };

    await IOUtils.makeDirectory(tmpDir, { createAncestors: true });
    const mineru = new MineruClient(project.config);
    const imagePaths = new Map();
    const counters = { submitted: 0 };
    const state = {
      overrides: project.sourceState.overrides,
      pendingIds: project.sourceState.pendingIds,
      translations: (await storage.readJson(storage.translationsPath(project.dir), {})) || {},
      eligibleIds: eligibleTranslationIds(project.blocks, project.config.translation),
      record: project.record
    };
    let queue = plan.targets.map((block) => blockDescriptor(attachment, block));
    const successful = new Set();
    const changed = new Set();
    let finalFailures = new Map();

    ctx.Zotero.debug?.(
      `PaperTranslate ${IMPLEMENTATION_MARKER}: start attachment=${attachment.id} `
      + `targets=${queue.length} restart=${restart} Zotero=${ctx.Zotero.version || "unknown"}`
    );

    for (let pass = 1; pass <= 2 && queue.length; pass += 1) {
      onProgress(pass === 1
        ? `准备后台裁切 ${queue.length} 个块…`
        : `自动重试 ${queue.length} 个失败块…`);
      const renderFailures = await renderMissingImages(
        project,
        queue,
        imagePaths,
        tmpDir,
        onProgress,
        shouldAbort
      );
      const renderFailedIds = new Set(renderFailures.map((item) => item.block.id));
      const ready = queue.filter((entry) => !renderFailedIds.has(entry.block.id));
      const outcomes = [];
      const persistAndTrack = async (batchOutcomes) => {
        if (!batchOutcomes.length) return;
        const didChange = await persistOutcomes(project, batchOutcomes, state);
        if (didChange) {
          await IOUtils.remove(
            storage.tocEnhancementPath(project.dir),
            { ignoreAbsent: true }
          ).catch(() => {});
        }
        outcomes.push(...batchOutcomes);
        for (const outcome of batchOutcomes) {
          if (outcome.success) {
            successful.add(outcome.block.id);
            if (outcome.changed) changed.add(outcome.block.id);
          }
        }
      };
      await persistAndTrack(renderFailures);
      for (const batch of chunkDocumentReparseItems(ready)) {
        const batchOutcomes = await submitBatch(
          project,
          batch,
          imagePaths,
          mineru,
          onProgress,
          shouldAbort,
          counters
        );
        await persistAndTrack(batchOutcomes);
        assertActive(attachment, shouldAbort);
      }
      finalFailures = new Map();
      for (const outcome of outcomes) {
        if (!outcome.success) {
          finalFailures.set(outcome.block.id, outcome);
        }
      }
      queue = pass === 1
        ? plan.targets
          .filter((block) => finalFailures.has(block.id))
          .map((block) => blockDescriptor(attachment, block))
        : [];
    }

    ctx.Zotero.debug?.(
      `PaperTranslate ${IMPLEMENTATION_MARKER}: complete attachment=${attachment.id} `
      + `submitted=${counters.submitted} success=${successful.size} failed=${finalFailures.size}`
    );
    return {
      submitted: counters.submitted,
      success: successful.size,
      changed: changed.size,
      failed: finalFailures.size,
      skipped: plan.skipped.length,
      priorSucceeded: plan.priorSucceeded
    };
  } finally {
    if (panelLocked) {
      notifyPaperDataChanged({
        attachmentID: attachment?.id,
        reason: "document-reparse-end"
      });
    }
    activeAttachments.delete(attachment?.id);
    await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true }).catch(() => {});
  }
}
