// 进度反馈：包装 Zotero.ProgressWindow，供长时间任务（解析/翻译）使用。

import { ctx } from "../context.mjs";

// fn(updateStatus) 中的异步操作期间显示进度；异常会以错误行展示并延迟关闭。
export async function runWithProgress(title, fn) {
  const { Zotero } = ctx;
  const pw = new Zotero.ProgressWindow({ closeOnClick: false });
  pw.changeHeadline(title);
  pw.show();
  const line = new pw.ItemProgress("", "准备中…");
  const update = (text) => {
    try {
      line.setText(String(text));
    } catch {
      // 进度窗已关闭等情况可忽略
    }
  };

  try {
    const result = await fn(update);
    update("完成");
    try {
      line.setProgress(100);
    } catch {}
    pw.startCloseTimer(3000);
    return result;
  } catch (error) {
    Zotero.logError(error);
    try {
      line.setError();
      line.setText(error.message || String(error));
    } catch {}
    pw.startCloseTimer(10000);
    return null;
  }
}
