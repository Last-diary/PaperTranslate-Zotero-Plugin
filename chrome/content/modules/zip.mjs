// ZIP 解压：用 XPCOM nsIZipReader 替代原项目的 yauzl（server/zip.js）。
// 保留原有的路径穿越防护逻辑（过滤 .. 与空段）。

const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");

export async function extractZip(zipPath, destDir) {
  const zipFile = new FileUtils.File(zipPath);
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
  reader.open(zipFile);
  try {
    await IOUtils.makeDirectory(destDir, { createAncestors: true });
    const entries = reader.findEntries("*");
    while (entries.hasMore()) {
      const entryName = entries.getNext();
      const normalized = String(entryName).replaceAll("\\", "/");
      if (normalized.endsWith("/")) continue;

      // 防御路径穿越：去掉驱动器号、空段、. 与 ..
      const parts = normalized
        .split("/")
        .filter((part) => part && part !== "." && part !== ".." && !/^[a-zA-Z]:$/.test(part));
      if (!parts.length) continue;

      const targetPath = PathUtils.join(destDir, ...parts);
      await IOUtils.makeDirectory(PathUtils.parent(targetPath), { createAncestors: true });
      await IOUtils.remove(targetPath, { ignoreAbsent: true });
      reader.extract(entryName, new FileUtils.File(targetPath));
    }
  } finally {
    reader.close();
  }
}
