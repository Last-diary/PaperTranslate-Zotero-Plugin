// 共享上下文：bootstrap 在 startup 时把 Zotero 对象与插件信息注入这里，
// 供所有 ESM 模块使用（ESM 模块作用域中没有 Zotero 全局对象）。
export const ctx = {
  Zotero: null,
  pluginID: "",
  version: "",
  rootURI: "",
  shuttingDown: false,
  // 本地打包的同步渲染依赖。DOMPurify 保留工厂函数，并在每个 Reader
  // window 中分别创建实例，避免跨 privileged compartment 传递 DOM。
  // MathJax 则由每个 Reader document 独立加载，避免共享错误的 document。
  marked: null,
  createDOMPurify: null,
  vendorSandboxes: []
};
