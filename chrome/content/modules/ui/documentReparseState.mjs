import { fnv1a64Hex } from "../utils.mjs";
import { canReparseBlock } from "./blockReparseText.mjs";
import { MINERU_FILES_PER_MINUTE } from "../mineruRateLimit.mjs";

export const MINERU_UPLOAD_BATCH_LIMIT = MINERU_FILES_PER_MINUTE;
export const DOCUMENT_REPARSE_RECORD_VERSION = 1;

export function chunkDocumentReparseItems(items, size = MINERU_UPLOAD_BATCH_LIMIT) {
  const safeSize = Math.max(1, Math.min(MINERU_UPLOAD_BATCH_LIMIT, Math.floor(Number(size)) || 1));
  const chunks = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

function stableBlockSignature(block) {
  return {
    id: block.id,
    type: block.type,
    pageIdx: block.pageIdx,
    bbox: block.bbox,
    pageSize: block.pageSize,
    regions: block.regions,
    regionsReliable: block.regionsReliable !== false
  };
}

export function documentReparseCampaignKey({ manifest, fileInfo, blocks, mineru } = {}) {
  const payload = {
    manifest: {
      version: manifest?.version || null,
      createdAt: manifest?.createdAt || "",
      contentList: manifest?.files?.contentList || ""
    },
    file: {
      size: Number(fileInfo?.size) || 0,
      lastModified: Number(fileInfo?.lastModified) || 0
    },
    mineru: {
      baseUrl: mineru?.baseUrl || "",
      modelVersion: mineru?.modelVersion || "",
      language: mineru?.language || "",
      isOcr: Boolean(mineru?.isOcr),
      enableFormula: Boolean(mineru?.enableFormula),
      enableTable: Boolean(mineru?.enableTable)
    },
    blocks: (blocks || []).map(stableBlockSignature)
  };
  return fnv1a64Hex(JSON.stringify(payload));
}

export function normalizeDocumentReparseRecord(value, campaignKey) {
  if (
    !value
    || value.version !== DOCUMENT_REPARSE_RECORD_VERSION
    || value.campaignKey !== campaignKey
    || !value.blocks
    || typeof value.blocks !== "object"
  ) {
    return {
      version: DOCUMENT_REPARSE_RECORD_VERSION,
      campaignKey,
      startedAt: "",
      updatedAt: "",
      blocks: {}
    };
  }
  return {
    version: DOCUMENT_REPARSE_RECORD_VERSION,
    campaignKey,
    startedAt: String(value.startedAt || ""),
    updatedAt: String(value.updatedAt || ""),
    blocks: { ...value.blocks }
  };
}

export function planDocumentReparse(blocks, record, { restart = false } = {}) {
  const all = Array.from(blocks || []);
  const candidates = all.filter(canReparseBlock);
  const skipped = all.filter((block) => !canReparseBlock(block));
  const succeededIds = new Set(
    Object.entries(record?.blocks || {})
      .filter(([, state]) => state?.status === "success")
      .map(([id]) => id)
  );
  const targets = restart
    ? candidates
    : candidates.filter((block) => !succeededIds.has(block.id));
  const priorSucceeded = candidates.length - targets.length;
  return {
    candidates,
    skipped,
    targets,
    priorSucceeded,
    firstPassConsumption: targets.length,
    maximumConsumption: targets.length * 2,
    batchCount: Math.ceil(targets.length / MINERU_UPLOAD_BATCH_LIMIT)
  };
}

export function recordDocumentReparseResult(record, block, result, now = new Date().toISOString()) {
  const next = {
    ...record,
    startedAt: record.startedAt || now,
    updatedAt: now,
    blocks: { ...record.blocks }
  };
  next.blocks[block.id] = {
    status: result.success ? "success" : "failed",
    attempts: Math.max(0, Number(result.attempts) || 0),
    changed: Boolean(result.changed),
    error: result.success ? "" : String(result.error || "未知错误"),
    updatedAt: now
  };
  return next;
}
