# QuizPilot

[English](README.en.md)

QuizPilot 是面向网页练习题的 AI 学习助手（Chrome 扩展）。在练习、作业或自测页面上点一下，它会读取题目、给出参考答案和置信度，帮你检查思路、找出薄弱点。

这个仓库是 QuizPilot 扩展和模型适配层的源代码。官网：<https://quizpilot.link>

**安装**：[Chrome 应用商店](https://chromewebstore.google.com/detail/quizpilot/gloldlbaimjdhcpgpcdcihcekfclgeha)

## 功能

- 支持单选、多选、判断、填空、简答，以及需要看图的题目
- 优先直接读取页面上的题目文字；读不全、题目是图片或画布时，再截图交给多模态模型识别
- 第一次遇到结构特殊的网站时，截图学习一次题目布局，之后直接复用
- 答案面板显示置信度；可以自动填写，也可以一键撤销，从不替你提交
- 辅助答题：只在页面上标出建议答案，由你自己选择
- 连续练习：一题一页的练习可以答完自动进入下一题，随时停止，到最后一题会停下
- 框选区域识别、右键菜单、快捷键

## 两种使用方式

- **免费版**：填入你自己的模型 API Key（Jev，或任何兼容 OpenAI 接口的服务，包括本地模型）。Key 只保存在浏览器里，题目直接从浏览器发给你选择的服务商，不经过我们的服务器。这部分的全部代码都在本仓库里，可以自己核实。
- **点数版**：登录后使用 quizpilot.link 提供的托管服务，按用量扣点。服务端不在本仓库中；自己构建的扩展只能使用免费版。

## 目录

```
apps/extension      Chrome 扩展（MV3，Vite + Preact）
  src/content       读题（extract）、填写（fill）、页面上的答案面板（ui）
  src/background    答题流程、截图、连续答题
  src/popup         工具栏弹窗
  src/options       设置页
  e2e               端到端测试（Playwright，使用模拟的模型接口）
packages/providers  模型适配层：Jev、OpenAI 兼容接口、路由与复核
packages/shared     扩展与服务端共用的类型和校验
```

## 开发

需要 Node.js 22 以上和 pnpm。

```bash
pnpm install
pnpm --filter @quizpilot/extension dev     # 开发模式，在 chrome://extensions 加载 apps/extension/dist
pnpm typecheck
pnpm test                                  # 单元测试
pnpm --filter @quizpilot/extension test:e2e  # 端到端测试（需要 Playwright 的 Chromium）
pnpm --filter @quizpilot/extension build
```

构建出的扩展在 `apps/extension/dist`。在 `chrome://extensions` 打开“开发者模式”，选择“加载已解压的扩展程序”即可。

## 网站适配

读题不针对特定网站：扩展按页面结构推断题目、选项和作答控件。遇到读不对的网站，欢迎提交 Issue，附上：

1. 页面地址（需要登录的页面请说明）；
2. 调试日志：设置 → 调试 → 打开“记录调试日志”，重现一次问题，再点“复制日志”或“下载日志”。日志只含题目、选项和处理步骤，不含 API Key。

修复时请在 `apps/extension/src/content/extract/*.test.ts` 里加一个用该网站真实结构写的测试。

## 请合理使用

QuizPilot 是学习辅助工具。请只在允许使用辅助工具的练习、作业和自测中使用，并遵守学校、考试机构和网站的规定，不要在禁止使用的考试或测评中使用。

## 许可证与商标

代码以 [GNU AGPL-3.0](LICENSE) 许可证发布。

“QuizPilot”名称和 Logo 不在开源许可范围内。基于本仓库发布的修改版本，请使用其他名称和图标。
