import test from "node:test";
import assert from "node:assert/strict";

import {
  blockCropViewRect,
  compositeCanvasSize,
  ratioRectToCanvasRect,
  resolvePdfPageContext,
  viewRatioRectToPdfRect
} from "../chrome/content/modules/ui/pdfBlockCrop.mjs";

test("multiple crop images keep reading order in a bounded vertical canvas", () => {
  assert.deepEqual(
    compositeCanvasSize([[100, 200], [80, 100]]),
    {
      width: 100,
      height: 324,
      scale: 1,
      gap: 24
    }
  );
  const bounded = compositeCanvasSize(
    [[100, 200], [80, 100]],
    { maxDimension: 200, maxPixels: 1_000_000 }
  );
  assert.equal(bounded.height, 200);
  assert.ok(bounded.width > 0 && bounded.width < 100);
});

test("block crop rect is normalized, padded, and clamped", () => {
  assert.deepEqual(
    blockCropViewRect({
      bbox: [100, 200, 300, 400],
      pageSize: [1000, 1000]
    }, 0.01),
    [0.09, 0.19, 0.31, 0.41]
  );
  assert.deepEqual(
    blockCropViewRect({
      bbox: [0, 0, 1000, 1000],
      pageSize: [1000, 1000]
    }),
    [0, 0, 1, 1]
  );
});

test("block crop rect rejects invalid MinerU coordinates", () => {
  assert.equal(blockCropViewRect({ bbox: [1, 2, 1, 4], pageSize: [10, 10] }), null);
  assert.equal(blockCropViewRect({ bbox: [1, 2, 3, 4] }), null);
});

test("view rect converts from top-left viewport coordinates to PDF coordinates", () => {
  const viewport = {
    width: 1000,
    height: 2000,
    convertToPdfPoint(x, y) {
      return [x, 2000 - y];
    }
  };
  assert.deepEqual(
    viewRatioRectToPdfRect(viewport, [0.1, 0.2, 0.3, 0.4]),
    [100, 1200, 300, 1600]
  );
});

test("block ratios map to the same PDF page canvas range used by block locating", () => {
  assert.deepEqual(
    ratioRectToCanvasRect([0.1, 0.2, 0.3, 0.4], 1000, 2000),
    [100, 400, 200, 400]
  );
  assert.equal(ratioRectToCanvasRect([0.2, 0.2, 0.2, 0.4], 100, 100), null);
});

test("page context falls back to the Reader page viewport when getPage lacks methods", async () => {
  const viewport = {
    width: 100,
    height: 200,
    convertToPdfPoint(x, y) {
      return [x, 200 - y];
    }
  };
  const result = await resolvePdfPageContext(
    { getPageView: () => ({ viewport }) },
    { getPage: async () => ({ pageNumber: 1 }) },
    0
  );
  assert.equal(result.viewport, viewport);
  assert.equal(typeof result.page.getViewport, "undefined");
});

test("page context prefers a full PDFPageProxy viewport", async () => {
  const pageViewport = {
    width: 300,
    height: 400,
    convertToPdfPoint() {
      return [0, 0];
    }
  };
  const page = {
    getViewport() {
      return pageViewport;
    }
  };
  const result = await resolvePdfPageContext(
    { getPageView: () => ({ viewport: { width: 1, height: 1 } }) },
    { getPage: async () => page },
    0
  );
  assert.equal(result.page, page);
  assert.equal(result.viewport, pageViewport);
});
