// 共享上下文：bootstrap 在 startup 时把 Zotero 对象与插件信息注入这里，
// 供所有 ESM 模块使用（ESM 模块作用域中没有 Zotero 全局对象）。
export const ctx = {
  Zotero: null,
  pluginID: "",
  version: "",
  rootURI: "",
  shuttingDown: false,
  // vendor/katex/katex.min.js 加载后的句柄
  katex: null
};
