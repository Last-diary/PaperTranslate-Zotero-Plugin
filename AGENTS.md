# Agent 开发约定

本文件适用于整个仓库。实现或修改功能前，Agent 必须遵守以下流程。

## 本地官方参考资料

仓库根目录的 `.references/` 保存 Zotero 官方资料的浅克隆，该目录不提交到 Git，也不会进入 XPI：

- `.references/zotero-docs/content/dev/`：Zotero 官方开发文档；
- `.references/zotero-reader/src/`：Zotero Reader 官方源码；
- `.references/zotero-source/chrome/content/zotero/xpcom/pluginAPI/`：插件公开接口实现；
- `.references/zotero-source/chrome/content/zotero/xpcom/reader.js`：Zotero 外层 Reader 集成；
- `.references/zotero-source/chrome/content/zotero/reader/`：Zotero Reader 外层资源。

开始 Zotero 相关功能前，在联网可用时先执行：

```powershell
.\sync-zotero-references.ps1
```

随后优先用 `rg` 搜索这些本地官方资料，并通过官方在线文档或仓库确认当前版本是否发生变化。本地副本是检索缓存，不能替代联网时的时效性核对。

## Zotero 功能先研究、后实现

凡是涉及 Zotero Reader、菜单、窗口、PDF viewer、条目面板、首选项或插件生命周期的新功能，必须先联网查找相关资料，不得仅凭通用 Web/DOM 经验直接实现。

按以下优先级查找依据：

1. Zotero 官方开发文档：
   - https://www.zotero.org/support/dev/zotero_7_for_developers
   - https://www.zotero.org/support/dev/zotero_8_for_developers
2. Zotero 官方源码：
   - https://github.com/zotero/zotero
   - https://github.com/zotero/reader
3. Zotero 官方示例插件及官方文档链接的示例。
4. 维护活跃、适配当前 Zotero 版本的开源插件实现。

研究时必须确认：

- 是否存在 Zotero 官方公开接口；
- 接口支持的 Zotero 版本、事件类型、参数和生命周期；
- 功能实际发生在哪个窗口、iframe、document 或事件链；
- 是否需要清理监听器、注销接口或处理 Reader 重建；
- 是否已有官方源码或成熟插件采用相同实现方式。

## 实现优先级

实现方案必须按以下顺序选择：

1. Zotero 官方公开 API；
2. Zotero 官方源码中稳定且可检测的内部接口；
3. 已验证的 Reader/DOM 事件入口；
4. 最后才考虑 monkey patch、私有字段或依赖具体 DOM 结构的方案。

如果必须使用私有 API 或 DOM 注入，必须同时：

- 在代码注释中说明为什么官方接口不满足需求；
- 将私有访问集中在独立函数中；
- 做能力检测，不假定字段一定存在；
- 提供安全降级路径；
- 添加能识别运行版本和执行阶段的调试日志；
- 避免跨 privileged compartment 传递复杂对象。

## 研究结果必须可追溯

开始编码前，应在工作更新或计划中简要写明：

- 查到的官方接口或源码入口；
- 最终选择的实现方式；
- 没有采用其他方案的具体原因。

如果联网不可用，必须明确说明，并先检查本地 Zotero 安装资源和仓库现有实现；不得把未经验证的猜测表述为官方行为。

## 验证要求

语法检查和成功打包不代表功能完成。涉及 Zotero 运行时行为时，必须区分：

- 静态验证：语法、构建、打包内容、差异检查；
- 运行验证：在目标 Zotero 版本中实际触发功能；
- 缓存验证：确认 Zotero 已重新加载最新源码，而不是旧的 ESM 缓存。

UI 与事件功能至少验证：

- 事件监听器确实挂载；
- 实际用户操作进入了预期事件入口；
- 菜单或面板可见且位置正确；
- 每个命令的功能和失败提示正常；
- 面板关闭、Reader 切换或插件卸载后监听器被清理。

开发代理模式修改 ESM 后，应完全退出 Zotero，并使用 `start-dev.ps1` 以 `-purgecaches` 重新启动。调试日志应包含可辨识的实现标记，方便确认当前运行代码。

只有静态检查而没有运行验证时，必须明确写成“静态验证通过，仍需 Zotero 运行验证”，不能声称功能已经完全完成。
