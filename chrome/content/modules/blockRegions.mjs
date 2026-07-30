import {
  blockRegionsPath,
  readJson,
  writeJson
} from "./storage.mjs";

const CACHE_VERSION = 1;
const NORMALIZED_PAGE_SIZE = Object.freeze([1000, 1000]);

function finiteRect(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.map(Number).every(Number.isFinite)
    && Number(value[2]) > Number(value[0])
    && Number(value[3]) > Number(value[1]);
}

function finitePageSize(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.map(Number).every(Number.isFinite)
    && Number(value[0]) > 0
    && Number(value[1]) > 0;
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function spanText(span) {
  return normalizedText(
    span?.content
    ?? span?.text
    ?? span?.html
    ?? span?.latex
    ?? ""
  );
}

function lineText(line) {
  const spans = Array.isArray(line?.spans) ? line.spans : [];
  return normalizedText(spans.map(spanText).filter(Boolean).join(" "));
}

function lineSignature(line) {
  if (!finiteRect(line?.bbox)) return "";
  const text = lineText(line);
  if (!text) return "";
  const bbox = line.bbox.map((value) => Math.round(Number(value) * 10) / 10);
  return `${text}\u0000${bbox.join(",")}`;
}

function collectLines(block, output = []) {
  if (!block || typeof block !== "object") return output;
  if (Array.isArray(block.lines)) {
    for (const line of block.lines) {
      if (finiteRect(line?.bbox)) output.push(line);
    }
  }
  if (Array.isArray(block.blocks)) {
    for (const child of block.blocks) collectLines(child, output);
  }
  return output;
}

function pageIndex(page, fallback) {
  const value = Number(page?.page_idx);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function pageSize(page) {
  return finitePageSize(page?.page_size)
    ? page.page_size.map(Number)
    : [...NORMALIZED_PAGE_SIZE];
}

function normalizedBbox(bbox, size) {
  if (!finiteRect(bbox) || !finitePageSize(size)) return null;
  const [width, height] = size.map(Number);
  const [x1, y1, x2, y2] = bbox.map(Number);
  return [
    Math.max(0, Math.min(1000, Math.floor(x1 * 1000 / width))),
    Math.max(0, Math.min(1000, Math.floor(y1 * 1000 / height))),
    Math.max(0, Math.min(1000, Math.ceil(x2 * 1000 / width))),
    Math.max(0, Math.min(1000, Math.ceil(y2 * 1000 / height)))
  ];
}

function bboxDistance(left, right) {
  if (!finiteRect(left) || !finiteRect(right)) return Number.POSITIVE_INFINITY;
  return left.reduce(
    (total, value, index) => total + Math.abs(Number(value) - Number(right[index])),
    0
  );
}

function layoutBlocks(page) {
  return []
    .concat(Array.isArray(page?.para_blocks) ? page.para_blocks : [])
    .concat(Array.isArray(page?.discarded_blocks) ? page.discarded_blocks : []);
}

function layoutPages(layout) {
  return Array.isArray(layout?.pdf_info) ? layout.pdf_info : [];
}

function buildRawLinePageIndex(pages) {
  const lookup = new Map();
  pages.forEach((page, fallbackPageIdx) => {
    const resolvedPageIdx = pageIndex(page, fallbackPageIdx);
    const preprocBlocks = Array.isArray(page?.preproc_blocks) ? page.preproc_blocks : [];
    for (const block of preprocBlocks) {
      for (const line of collectLines(block)) {
        const signature = lineSignature(line);
        if (!signature) continue;
        if (!lookup.has(signature)) lookup.set(signature, []);
        const pageIndexes = lookup.get(signature);
        if (!pageIndexes.includes(resolvedPageIdx)) pageIndexes.push(resolvedPageIdx);
      }
    }
  });
  return lookup;
}

function matchLayoutBlocks(contentBlocks, pages) {
  const pageCandidates = new Map();
  pages.forEach((page, fallbackPageIdx) => {
    const resolvedPageIdx = pageIndex(page, fallbackPageIdx);
    const size = pageSize(page);
    pageCandidates.set(
      resolvedPageIdx,
      layoutBlocks(page).map((block, order) => ({
        block,
        order,
        normalizedBbox: normalizedBbox(block?.bbox, size),
        used: false
      }))
    );
  });

  const pageCursors = new Map();
  return contentBlocks.map((contentBlock) => {
    const resolvedPageIdx = Math.max(0, Number(contentBlock?.page_idx) || 0);
    const candidates = pageCandidates.get(resolvedPageIdx) || [];
    const contentBbox = finiteRect(contentBlock?.bbox)
      ? contentBlock.bbox.map(Number)
      : null;
    const cursor = pageCursors.get(resolvedPageIdx) || 0;
    let best = null;

    for (const candidate of candidates) {
      if (candidate.used) continue;
      const distance = bboxDistance(contentBbox, candidate.normalizedBbox);
      const orderPenalty = Math.abs(candidate.order - cursor) * 0.01;
      const score = distance + orderPenalty;
      if (!best || score < best.score) best = { candidate, score, distance };
    }

    // content_list 和 para_blocks 使用相同顺序生成，但不同 MinerU
    // 后端可能省略空块。优先按 bbox 匹配；无法匹配时只接受当前游标，
    // 防止把后续逻辑段落的行级位置错误地绑定到当前段落。
    if (!best || (contentBbox && best.distance > 24)) {
      const fallback = candidates.find((candidate) => !candidate.used && candidate.order >= cursor);
      if (!fallback || contentBbox) return null;
      best = { candidate: fallback };
    }

    best.candidate.used = true;
    pageCursors.set(resolvedPageIdx, best.candidate.order + 1);
    return {
      pageIdx: resolvedPageIdx,
      page: pages.find((page, index) => pageIndex(page, index) === resolvedPageIdx),
      block: best.candidate.block
    };
  });
}

function resolvedLinePage(line, parentPageIdx, previousPageIdx, rawLinePages) {
  const spans = Array.isArray(line?.spans) ? line.spans : [];
  const crossPage = Boolean(
    line?.cross_page
    || spans.some((span) => span?.cross_page)
  );
  const candidates = rawLinePages.get(lineSignature(line)) || [];
  if (crossPage) {
    const exact = candidates
      .filter((value) => value > parentPageIdx && value >= previousPageIdx)
      .sort((left, right) => left - right)[0];
    if (Number.isInteger(exact)) return { pageIdx: exact, reliable: true };
    return {
      pageIdx: Math.max(parentPageIdx + 1, previousPageIdx),
      reliable: false
    };
  }
  if (candidates.includes(parentPageIdx)) {
    return { pageIdx: parentPageIdx, reliable: true };
  }
  return { pageIdx: parentPageIdx, reliable: true };
}

function overlapRatio(left, right) {
  const overlap = Math.max(
    0,
    Math.min(Number(left[2]), Number(right[2]))
      - Math.max(Number(left[0]), Number(right[0]))
  );
  const minimumWidth = Math.max(
    1,
    Math.min(Number(left[2]) - Number(left[0]), Number(right[2]) - Number(right[0]))
  );
  return overlap / minimumWidth;
}

function startsNewRegion(previous, current, size) {
  if (!previous || previous.pageIdx !== current.pageIdx) return true;
  const previousBox = previous.bbox;
  const currentBox = current.bbox;
  const previousHeight = Math.max(1, previousBox[3] - previousBox[1]);
  const currentHeight = Math.max(1, currentBox[3] - currentBox[1]);
  const lineHeight = Math.max(previousHeight, currentHeight);
  const verticalReset = currentBox[1] < previousBox[1] - Math.max(lineHeight * 1.5, size[1] * 0.01);
  const separateColumn = overlapRatio(previousBox, currentBox) < 0.2
    && Math.abs(currentBox[0] - previousBox[0]) > lineHeight * 2;
  const verticalGap = currentBox[1] - previousBox[3];
  const disconnected = verticalGap > Math.max(lineHeight * 8, size[1] * 0.08);
  return verticalReset || separateColumn || disconnected;
}

function unionBbox(left, right) {
  return [
    Math.min(left[0], right[0]),
    Math.min(left[1], right[1]),
    Math.max(left[2], right[2]),
    Math.max(left[3], right[3])
  ];
}

function regionForContentBlock(contentBlock) {
  if (!finiteRect(contentBlock?.bbox)) return null;
  return {
    pageIdx: Math.max(0, Number(contentBlock.page_idx) || 0),
    bbox: contentBlock.bbox.map(Number),
    pageSize: [...NORMALIZED_PAGE_SIZE]
  };
}

function regionsFromLayoutMatch(contentBlock, match, pagesByIndex, rawLinePages) {
  if (!match?.block) {
    const fallback = regionForContentBlock(contentBlock);
    return {
      regions: fallback ? [fallback] : [],
      reliable: false
    };
  }

  const lines = collectLines(match.block);
  if (!lines.length) {
    const fallback = regionForContentBlock(contentBlock);
    return {
      regions: fallback ? [fallback] : [],
      reliable: Boolean(fallback)
    };
  }

  let previousPageIdx = match.pageIdx;
  let reliable = true;
  const positionedLines = lines.map((line) => {
    const resolved = resolvedLinePage(
      line,
      match.pageIdx,
      previousPageIdx,
      rawLinePages
    );
    previousPageIdx = resolved.pageIdx;
    reliable = reliable && resolved.reliable;
    return {
      pageIdx: resolved.pageIdx,
      bbox: line.bbox.map(Number)
    };
  });

  const rawRegions = [];
  let current = null;
  let previous = null;
  for (const line of positionedLines) {
    const size = pageSize(pagesByIndex.get(line.pageIdx));
    if (!current || startsNewRegion(previous, line, size)) {
      current = {
        pageIdx: line.pageIdx,
        bbox: [...line.bbox]
      };
      rawRegions.push(current);
    } else {
      current.bbox = unionBbox(current.bbox, line.bbox);
    }
    previous = line;
  }

  const regions = rawRegions
    .map((region) => ({
      pageIdx: region.pageIdx,
      bbox: normalizedBbox(region.bbox, pageSize(pagesByIndex.get(region.pageIdx))),
      pageSize: [...NORMALIZED_PAGE_SIZE]
    }))
    .filter((region) => finiteRect(region.bbox));

  const fallback = regionForContentBlock(contentBlock);
  return {
    regions: regions.length ? regions : (fallback ? [fallback] : []),
    reliable: reliable && Boolean(regions.length)
  };
}

export function buildContentRegionEntries(contentBlocks, layout) {
  if (!Array.isArray(contentBlocks)) return [];
  const pages = layoutPages(layout);
  if (!pages.length) return contentBlocks.map(() => null);
  const pagesByIndex = new Map(
    pages.map((page, index) => [pageIndex(page, index), page])
  );
  const rawLinePages = buildRawLinePageIndex(pages);
  const matches = matchLayoutBlocks(contentBlocks, pages);
  return contentBlocks.map((contentBlock, index) => (
    regionsFromLayoutMatch(
      contentBlock,
      matches[index],
      pagesByIndex,
      rawLinePages
    )
  ));
}

async function pickLayoutFile(dir, manifest = null) {
  const manifestFile = manifest?.files?.layout;
  if (manifestFile && await IOUtils.exists(PathUtils.join(dir, manifestFile))) {
    return manifestFile;
  }
  const children = await IOUtils.getChildren(dir).catch(() => []);
  const names = children.map((path) => PathUtils.filename(path));
  if (names.includes("layout.json")) return "layout.json";
  return names.find((name) => name.endsWith("_middle.json")) || "";
}

export async function loadContentRegionEntries(
  dir,
  manifest,
  contentFile,
  contentBlocks
) {
  const layoutFile = await pickLayoutFile(dir, manifest);
  if (!layoutFile) return null;

  const cachePath = blockRegionsPath(dir);
  const cached = await readJson(cachePath, null);
  if (
    cached?.version === CACHE_VERSION
    && cached.contentFile === contentFile
    && cached.layoutFile === layoutFile
    && cached.contentCount === contentBlocks.length
    && Array.isArray(cached.entries)
    && cached.entries.length === contentBlocks.length
  ) {
    return cached.entries;
  }

  const layout = await readJson(PathUtils.join(dir, layoutFile), null);
  if (!layout) return null;
  const entries = buildContentRegionEntries(contentBlocks, layout);
  await writeJson(cachePath, {
    version: CACHE_VERSION,
    contentFile,
    layoutFile,
    contentCount: contentBlocks.length,
    entries
  }).catch(() => {});
  return entries;
}

export function regionsForBlock(block) {
  const regions = Array.isArray(block?.regions)
    ? block.regions.filter((region) => (
      Number.isInteger(Number(region?.pageIdx))
      && Number(region.pageIdx) >= 0
      && finiteRect(region?.bbox)
      && finitePageSize(region?.pageSize)
    )).map((region) => ({
      pageIdx: Number(region.pageIdx),
      bbox: region.bbox.map(Number),
      pageSize: region.pageSize.map(Number)
    }))
    : [];
  if (regions.length) return regions;
  const fallback = regionForContentBlock({
    page_idx: block?.pageIdx,
    bbox: block?.bbox
  });
  if (fallback && finitePageSize(block?.pageSize)) {
    fallback.pageSize = block.pageSize.map(Number);
  }
  return fallback ? [fallback] : [];
}

export function matchBlockRegionAtPoint(blocks, point) {
  if (
    !point
    || !Number.isInteger(Number(point.pageIdx))
    || !Number.isFinite(Number(point.xRatio))
    || !Number.isFinite(Number(point.yRatio))
  ) {
    return null;
  }

  let best = null;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const region of regionsForBlock(block)) {
      if (Number(region.pageIdx) !== Number(point.pageIdx)) continue;
      const [x1, y1, x2, y2] = region.bbox.map(Number);
      const [pageWidth, pageHeight] = region.pageSize.map(Number);
      const valid = [x1, y1, x2, y2, pageWidth, pageHeight].every(Number.isFinite)
        && pageWidth > 0
        && pageHeight > 0
        && x2 > x1
        && y2 > y1;
      if (!valid) continue;

      const left = Math.max(0, Math.min(1, x1 / pageWidth));
      const top = Math.max(0, Math.min(1, y1 / pageHeight));
      const right = Math.max(left, Math.min(1, x2 / pageWidth));
      const bottom = Math.max(top, Math.min(1, y2 / pageHeight));
      const inside = point.xRatio >= left
        && point.xRatio <= right
        && point.yRatio >= top
        && point.yRatio <= bottom;
      const dx = point.xRatio < left
        ? left - point.xRatio
        : point.xRatio > right ? point.xRatio - right : 0;
      const dy = point.yRatio < top
        ? top - point.yRatio
        : point.yRatio > bottom ? point.yRatio - bottom : 0;
      const area = Math.max(0.000001, (right - left) * (bottom - top));
      const score = inside ? -1 / area : dx * dx + dy * dy;
      if (!best || score < best.score) best = { block, region, score };
    }
  }
  return best;
}
