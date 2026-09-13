import test from "node:test";
import assert from "node:assert/strict";

import {
  blockCropViewRect,
  compositeCanvasSize,
  ratioRectToCanvasRect,
  renderFromExistingPageCanvas,
  resolvePdfPageContext,
  viewRatioRectToPdfRect
} from "../chrome/content/modules/ui/pdfBlockCrop.mjs";

test("multiple crop images keep reading order without an artificial gap", () => {
  assert.deepEqual(
    compositeCanvasSize([[100, 200], [80, 100]]),
    {
      width: 100,
      height: 300,
      scale: 1,
      gap: 0
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

test("zero padding preserves the original MinerU block bounds", () => {
  assert.deepEqual(
    blockCropViewRect({
      bbox: [100, 200, 300, 400],
      pageSize: [1000, 1000]
    }, 0),
    [0.1, 0.2, 0.3, 0.4]
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

test("existing page canvas crop never navigates or scrolls the Reader", () => {
  let navigateCalls = 0;
  let drawnSource = null;
  const sourceCanvas = { width: 1000, height: 2000 };
  const outputCanvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage(source) {
          drawnSource = source;
        }
      };
    },
    toDataURL() {
      return "data:image/png;base64,crop";
    }
  };
  const page = {
    querySelectorAll() {
      return [sourceCanvas];
    }
  };
  const doc = {
    getElementById() {
      return {};
    },
    querySelector() {
      return page;
    },
    createElement(tag) {
      assert.equal(tag, "canvas");
      return outputCanvas;
    }
  };
  const reader = {
    navigate() {
      navigateCalls += 1;
      throw new Error("crop must not navigate");
    },
    _internalReader: {
      _primaryView: {
        _iframeWindow: { document: doc }
      }
    }
  };

  const image = renderFromExistingPageCanvas(
    reader,
    0,
    [0.1, 0.2, 0.3, 0.4]
  );

  assert.equal(image, "data:image/png;base64,crop");
  assert.equal(navigateCalls, 0);
  assert.equal(drawnSource, sourceCanvas);
  assert.deepEqual([outputCanvas.width, outputCanvas.height], [0, 0]);
});

test("missing page canvas falls through without navigating", () => {
  let navigateCalls = 0;
  const reader = {
    navigate() {
      navigateCalls += 1;
    },
    _internalReader: {
      _primaryView: {
        _iframeWindow: {
          document: {
            getElementById() {
              return {};
            },
            querySelector() {
              return null;
            }
          }
        }
      }
    }
  };

  assert.equal(
    renderFromExistingPageCanvas(reader, 4, [0.1, 0.2, 0.3, 0.4]),
    null
  );
  assert.equal(navigateCalls, 0);
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

test("a viewport with methods but NaN dimensions falls back to the viewer viewport", async () => {
  const viewport = { width: 612, height: 792, convertToPdfPoint: (x, y) => [x, 792 - y] };
  const page = { getViewport: () => ({ ...viewport, width: NaN, height: NaN }) };
  const result = await resolvePdfPageContext(
    { getPageView: () => ({ pdfPage: page, viewport }) }, {}, 0
  );
  assert.equal(result.viewport, viewport);
  assert.deepEqual(viewRatioRectToPdfRect(result.viewport, [0, 0, 1, 1]), [0, 0, 612, 792]);
});

test("invalid page and viewer viewports fail safely", async () => {
  const invalid = { width: Infinity, height: 0, convertToPdfPoint: () => [NaN, NaN] };
  const result = await resolvePdfPageContext(
    { getPageView: () => ({ pdfPage: { getViewport: () => invalid }, viewport: invalid }) }, {}, 0
  );
  assert.equal(result.viewport, null);
});

test("PDF.js viewport options are cloned into the supplied Reader realm", async () => {
  const originalCu = globalThis.Cu;
  const readerWindow = {};
  const cloned = new WeakSet();
  const viewport = { width: 612, height: 792, convertToPdfPoint: (x, y) => [x, 792 - y] };
  globalThis.Cu = {
    cloneInto(value, target) {
      assert.equal(target, readerWindow);
      const copy = { ...value };
      cloned.add(copy);
      return copy;
    }
  };
  try {
    const page = { getViewport(options) {
      assert.ok(cloned.has(options), "privileged options must not reach PDF.js directly");
      assert.equal(options.scale, 1);
      return viewport;
    } };
    const result = await resolvePdfPageContext(
      { getPageView: () => ({ pdfPage: page }) }, {}, 0, readerWindow
    );
    assert.equal(result.viewport, viewport);
  } finally {
    if (originalCu === undefined) delete globalThis.Cu;
    else globalThis.Cu = originalCu;
  }
});
