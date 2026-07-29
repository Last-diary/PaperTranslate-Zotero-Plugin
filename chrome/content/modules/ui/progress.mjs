// 进度反馈：包装 Zotero.ProgressWindow，供长时间任务（解析/翻译）使用。

import { ctx } from "../context.mjs";

// fn(updateStatus) 中的异步操作期间显示进度；异常会以错误行展示并延迟关闭。
export async function runWithProgress(title, fn) {
  const { Zotero } = ctx;
  const pw = new Zotero.ProgressWindow({ closeOnClick: true });
  pw.changeHeadline(title);
  pw.show();
  // Zotero 自身的短通知采用“简短标题 + 带类型图标的单行状态”。
  // 不把论文标题等长文本塞进这一行，避免窄窗口出现不自然的多行换行。
  const line = new pw.ItemProgress("attachmentPDF", "准备中…");
  const update = (text) => {
    try {
      line.setText(String(text));
    } catch {
      // 进度窗已关闭等情况可忽略
    }
  };
  const closeLater = (delay) => {
    try {
      pw.startCloseTimer(delay);
    } catch {}
    // Zotero 自带的关闭计时器会在鼠标悬停时暂停。增加一个不受悬停
    // 影响的兜底计时，确保通知最终一定关闭。
    setTimeout(() => {
      try {
        pw.close();
      } catch {}
    }, delay + 250);
  };

  try {
    const result = await fn(update);
    update(typeof result === "string" && result.trim() ? result : "完成");
    try {
      line.setItemTypeAndIcon(null, "tick");
      line.setProgress(100);
    } catch {}
    closeLater(4500);
    return result;
  } catch (error) {
    Zotero.logError(error);
    try {
      line.setError();
      line.setText(error.message || String(error));
    } catch {}
    closeLater(9000);
    return null;
  }
}
