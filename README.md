# Conversation Curator

[简体中文](README.md) | [English](README.en.md)

本地、只读地处理 ChatGPT `conversations.json`，执行确定性敏感扫描和启发式分类，并在用户显式确认后导出不含消息正文的 JSON 报告。

## 概览

把它理解成一个**只在你自己电脑上工作的 ChatGPT 对话整理助手**：你提供 ChatGPT 官方导出中的 `conversations.json`，它会按主题和状态整理对话、标出可能含敏感内容或需要人工确认的项目，并先给你看汇总结果。

它默认不写文件，不登录你的 ChatGPT 账户，不上传聊天内容，也不会替你重命名、归档或删除任何对话。只有你明确指定保存位置后，它才会生成一份不含消息正文的本地 JSON 报告。

最简单的调用方式：

1. 从 ChatGPT 导出数据并解压，找到 `conversations.json`。
2. 在 Codex 中输入：

   ```text
   $conversation-curator 请整理这个文件：/path/to/conversations.json
   ```

3. 先查看汇总数量；如果需要详细报告，再明确告诉它保存到哪个本地路径。

适合用来：快速了解对话主要分布、发现需要人工复核的项目，并在整理前检查明显的敏感信息风险。它不是云端同步工具，也不能直接操作 ChatGPT 里的会话。

## 工作方式

```text
ChatGPT 导出文件（只读）
  → 增量解析
  → 当前分支规范化
  → 本地敏感扫描
  → 本地启发式分类
  → 终端预览
  → 可选 JSON 报告
```

本项目不连接 ChatGPT，不调用远程模型，不发送遥测，也不修改原平台数据。

## 作为 Codex Skill 使用

本仓库根目录的 [SKILL.md](SKILL.md) 是面向最终用户的 Skill 入口。准备 Node.js 24 后，将完整仓库放在 Codex 的用户 Skill 目录（例如 macOS/Linux 的 `~/.agents/skills/conversation-curator/`），确认其中同时存在 `SKILL.md` 与 `src/cli.ts`。如果 Skill 没有出现，重启 Codex；然后可用 `$conversation-curator` 请求整理已导出的 ChatGPT 对话。它只在你提供本地导出文件路径后运行；Skill 约定只把汇总计数显示给 Codex，计数会成为当前 Codex 对话的一部分。详细分类建议保存在你明确指定的本地报告中，由你自行查看和决定是否采纳。当前不支持直接重命名、移动或归档平台上的对话。

## 环境要求

项目使用 Node.js 24.19.0 验证。CLI 运行时不依赖第三方包；贡献者需要安装锁定的 TypeScript 开发依赖以执行静态检查。
本地 CLI 在 macOS 上验证；Linux 的 GitHub CI `verify` 与 `Git history secret scan` 任务均已通过；Windows 尚未验证。

## 使用

只预览，不写文件：

```bash
node src/cli.ts --input /path/to/conversations.json
```

通过 Codex 调用时只显示汇总计数：

```bash
node src/cli.ts --input /path/to/conversations.json --summary-only
```

显式导出：

```bash
node src/cli.ts \
  --input /path/to/conversations.json \
  --write \
  --output .private-reports/conversation-report.json
```

如输出已存在，只有额外传入 `--force` 才允许替换。

仓库内导出时请先创建 `.private-reports/`；该目录已被 Git 忽略。报告采用可增量写出的 JSON 事件数组，事件顺序为：

```text
header → conversation / failure（逐条）→ summary
```

当前报告 `schemaVersion` 为 `1.3`。相较 `1.1`，汇总事件新增
`currentBranchParsed`、`branchFallbacks`、`contentUnavailable` 和 `classificationTruncated`；消费方应按版本解析，
并允许同一主版本内新增汇总字段。

源对话 ID 在输出前转换为单向本地引用，原始文件名不会写入报告或终端；错误、标签和分类字段等所有输出字符串都会再次扫描和脱敏。只有最终序列化输出扫描通过后，临时报告才会原子提交。
成功报告中的 `privacy.sensitiveValuesIncluded` 固定为 `false`：如果输出扫描发现敏感值，运行会在汇总事件写出和报告提交前失败，而不会生成一个把该字段设为 `true` 的报告。

## 隐私模型

- 输入文件只读，运行前后不应发生变化。
- 确定性敏感扫描覆盖标题、当前分支全部文本及文件名、内容类型等白名单附件元数据；分类只接收脱敏后的标题，以及首三条和末三条文本采样。
- 单条分类文本超过 32 Ki 字符时仅保留首尾片段并强制人工复核；确定性敏感扫描仍覆盖完整文本。
- 直接运行 CLI 时会在本地启动一个带固定 V8 堆边界的子进程；输入路径仅作为本机进程参数传递，不上传或记录。
- 附件正文、二进制、图片和音频内容不进入扫描或分类上下文。
- 报告保存分组文件哈希、单向对话引用、统计和分类字段，但不保存消息正文、原始标题、源对话 ID 或敏感匹配值。
- 没有数据库和跨设备同步；删除导出的报告即可删除这次运行保存的结果。
- 当前适配器已用一份从真实导出保留结构、替换全部内容的本地脱敏副本完成兼容检查（22/22 项可分类）。该副本不随仓库或安装包发布；验证只覆盖这份导出的结构，不代表所有导出版本都兼容。
- 空数组、没有成功分类项、重复 ID 或部分失败项使 CLI 返回非零状态；此时报告可供排查，但不表示完整成功。S3 和 S3 候选汇总计数也包含已扫描但未分类的重复项。

## 限制

- 输入文件上限：256 MiB。
- 对话数量上限：50,000。
- 单个对话对象上限：8 MiB。
- 最近一次本机数量基准：50,000 条、15,316,673 字节输入、50,950,654 字节输出；峰值 RSS 128.1 MiB。
- 最近一次本机近上限基准：4,000 条、261,212,673 字节输入（约 249.1 MiB）、4,148,654 字节输出；峰值 RSS 122.7 MiB。
- 最近一次本机大对象基准：30 条、225,008,913 字节输入（单条正文约 7.15 MiB）、31,754 字节输出；峰值 RSS 172.6 MiB。

三项结果均低于 256 MiB 基准阈值，但只证明上述合成数据形态，不代表所有真实导出都具有相同内存曲线。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm policy:repository
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:memory -- --items 50000 --max-rss-mib 256
pnpm benchmark:input-limit
pnpm benchmark:large-items
pnpm pack:check
pnpm package:smoke
```

测试只生成合成输入，不使用真实对话。

真实格式兼容检查使用仅限本机的脱敏导出。将文件保存为
`.private-test-data/conversations.json` 后运行：

```bash
pnpm compatibility:private
```

该目录已被 Git 忽略，也不会进入发布包。检查过程不生成报告，不输出路径、标题、正文、ID
或分类明细，只返回安全的汇总计数；文件缺失、没有可分类项或出现任一失败项时均返回非零状态，
且不会解除发布阻塞。

## 文档

本项目采用 [Apache-2.0](LICENSE) 许可证。隐私和安全说明分别见
[PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。
版本记录见 [CHANGELOG.md](CHANGELOG.md)。

详细需求和验收案例见 [docs/implementation-spec.md](docs/implementation-spec.md)。
公开发布门槛见 [docs/release-checklist.md](docs/release-checklist.md)。
