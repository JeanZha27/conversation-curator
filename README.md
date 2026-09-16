# Conversation Curator

本地、只读地处理 ChatGPT `conversations.json`，执行确定性敏感扫描和启发式分类，并在用户显式确认后导出不含消息正文的 JSON 报告。

## 当前闭环

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

## 环境

本轮使用 Node.js 24.19.0 验证。CLI 运行时不依赖第三方包；贡献者需要安装锁定的 TypeScript 开发依赖以执行静态检查。

## 使用

只预览，不写文件：

```bash
node src/cli.ts --input /path/to/conversations.json
```

显式导出：

```bash
node src/cli.ts \
  --input /path/to/conversations.json \
  --write \
  --output /path/to/conversation-report.json
```

如输出已存在，只有额外传入 `--force` 才允许替换。

报告采用可增量写出的 JSON 事件数组，事件顺序为：

```text
header → conversation / failure（逐条）→ summary
```

源对话 ID 在输出前转换为单向本地引用；文件名、错误、标签和分类字段等所有输出字符串都会再次扫描和脱敏。只有最终输出扫描通过后，临时报告才会原子提交。

## 测试

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm benchmark:memory -- --items 50000 --max-rss-mib 256
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

## 数据边界

- 输入文件只读，运行前后不应发生变化。
- 报告保存分组文件哈希、单向对话引用、统计和分类字段，但不保存消息正文、原始标题、源对话 ID 或敏感匹配值。
- 没有数据库和跨设备同步；删除导出的报告即可删除本轮持久化结果。
- 当前适配器基于合成的常见 ChatGPT 导出结构验证。未提供真实脱敏样本，因此真实格式兼容性仍需验证。

## 当前运行边界

- 输入文件上限：256 MiB。
- 对话数量上限：50,000。
- 单个对话对象上限：8 MiB。
- 已执行的合成基准：50,000 条、15,266,673 字节输入、49,350,595 字节输出；峰值 RSS 210.2 MiB，低于声明的 256 MiB 基准阈值。

该基准只证明上述合成数据形态，不代表所有 256 MiB 文件都具有相同内存曲线。

本项目采用 [Apache-2.0](LICENSE) 许可证。隐私和安全说明分别见
[PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

详细需求和验收案例见 [docs/implementation-spec.md](docs/implementation-spec.md)。
公开发布门槛见 [docs/release-checklist.md](docs/release-checklist.md)。
