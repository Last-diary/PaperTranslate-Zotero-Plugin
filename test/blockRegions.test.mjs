import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContentRegionEntries,
  matchBlockRegionAtPoint,
  regionsForBlock
} from "../chrome/content/modules/blockRegions.mjs";

const spanLine = (bbox, content, extra = {}) => ({
  bbox,
  spans: [{ bbox, type: "text", content, ...extra }]
});

test("MinerU logical paragraph keeps separate same-page column regions", () => {
  const leftA = spanLine([50, 700, 290, 712], "Paragraph starts");
  const leftB = spanLine([50, 716, 260, 728], "at the left bottom.");
  const rightA = spanLine([310, 80, 550, 92], "It continues");
  const rightB = spanLine([310, 96, 500, 108], "at the right top.");
  const layout = {
    pdf_info: [{
      page_idx: 0,
      page_size: [600, 800],
      preproc_blocks: [
        { type: "text", bbox: [50, 700, 290, 728], lines: [leftA, leftB] },
        { type: "text", bbox: [310, 80, 550, 108], lines: [rightA, rightB] }
      ],
      para_blocks: [{
        type: "text",
        bbox: [50, 700, 290, 728],
        lines: [leftA, leftB, rightA, rightB]
      }],
      discarded_blocks: []
    }]
  };
  const content = [{
    type: "text",
    text: "Paragraph starts at the left bottom. It continues at the right top.",
    bbox: [83, 875, 484, 910],
    page_idx: 0
  }];

  const [entry] = buildContentRegionEntries(content, layout);
  assert.equal(entry.reliable, true);
  assert.deepEqual(entry.regions.map((region) => region.pageIdx), [0, 0]);
  assert.equal(entry.regions.length, 2);
  assert.ok(entry.regions[0].bbox[1] > entry.regions[1].bbox[1]);
});

test("cross-page spans recover their source page from preproc blocks", () => {
  const first = spanLine([50, 730, 290, 742], "Paragraph starts on page one");
  const second = spanLine(
    [50, 80, 280, 92],
    "and continues on page two.",
    { cross_page: true }
  );
  const rawSecond = spanLine([50, 80, 280, 92], "and continues on page two.");
  const layout = {
    pdf_info: [
      {
        page_idx: 0,
        page_size: [600, 800],
        preproc_blocks: [{ type: "text", bbox: [50, 730, 290, 742], lines: [first] }],
        para_blocks: [{
          type: "text",
          bbox: [50, 730, 290, 742],
          lines: [first, second]
        }],
        discarded_blocks: []
      },
      {
        page_idx: 1,
        page_size: [600, 800],
        preproc_blocks: [{ type: "text", bbox: [50, 80, 280, 92], lines: [rawSecond] }],
        para_blocks: [{ type: "text", bbox: [50, 80, 280, 92], lines: [] }],
        discarded_blocks: []
      }
    ]
  };
  const content = [{
    type: "text",
    text: "Paragraph starts on page one and continues on page two.",
    bbox: [83, 912, 484, 928],
    page_idx: 0
  }];

  const [entry] = buildContentRegionEntries(content, layout);
  assert.equal(entry.reliable, true);
  assert.deepEqual(entry.regions.map((region) => region.pageIdx), [0, 1]);
});

test("PDF points on any physical region select the same logical block", () => {
  const block = {
    id: "logical",
    regions: [
      { pageIdx: 0, bbox: [100, 800, 400, 900], pageSize: [1000, 1000] },
      { pageIdx: 1, bbox: [100, 100, 400, 200], pageSize: [1000, 1000] }
    ]
  };
  const match = matchBlockRegionAtPoint([block], {
    pageIdx: 1,
    xRatio: 0.2,
    yRatio: 0.15
  });
  assert.equal(match.block, block);
  assert.equal(match.region.pageIdx, 1);
});

test("legacy blocks retain a single fallback region", () => {
  assert.deepEqual(
    regionsForBlock({
      pageIdx: 2,
      bbox: [10, 20, 30, 40],
      pageSize: [1000, 1000]
    }),
    [{
      pageIdx: 2,
      bbox: [10, 20, 30, 40],
      pageSize: [1000, 1000]
    }]
  );
});
