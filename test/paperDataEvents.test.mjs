import test from "node:test";
import assert from "node:assert/strict";

import {
  clearPaperDataListeners,
  isPaperDataBusy,
  notifyPaperDataChanged,
  onPaperDataBusyCheck,
  onPaperDataChanged
} from "../chrome/content/modules/paperDataEvents.mjs";

test("paper data event bus locks only the matching busy attachment", () => {
  const received = [];
  const removeListener = onPaperDataChanged((detail) => received.push(detail));
  const removeBusyCheck = onPaperDataBusyCheck(({ attachmentID }) => attachmentID === 42);
  try {
    assert.equal(isPaperDataBusy({ attachmentID: 42 }), true);
    assert.equal(isPaperDataBusy({ attachmentID: 7 }), false);
    notifyPaperDataChanged({ attachmentID: 42, reason: "document-reparse-start" });
    assert.deepEqual(received, [
      { attachmentID: 42, reason: "document-reparse-start" }
    ]);
  } finally {
    removeListener();
    removeBusyCheck();
    clearPaperDataListeners();
  }
});
