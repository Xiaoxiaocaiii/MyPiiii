# Agent Playground Harness

[English README](README.md)

一个本地优先的 Agent 实验 Harness，用于运行、追踪、回放和评估单 Agent
实验。

当模型调用、工具结果、上下文和评测逻辑混在一起时，Agent 方案很难进行可靠
比较。本项目将这些边界明确分开，并记录足够的证据来回答三个问题：

- 实验是否真的有所改进？
- 失败发生在模型、工具、上下文还是运行时？
- 能否不再次调用模型和工具，重新检查一次运行过程？

标准 Demo 使用确定性的离线 Fake Model，对 20 条仓库问答任务运行 Baseline
和 Ablation 对比，生成带完整性校验的运行工件，并回放正常样本和回归样本。

## 主要能力

- 版本化、JSON 安全的 Runtime 和 Model 契约
- 基于 Schema 的工具注册、权限控制、超时和错误归一化
- 确定性的上下文窗口构建
- append-only JSONL Trace 和 SQLite 运行索引
- SHA-256 工件完整性校验
- 不调用模型或工具的离线 Replay
- 确定性评分、Baseline/Ablation 对比报告
- 支持模型、工具、上下文、运行时、存储和 Trace 完整性的失败归因

## 工作流程

```text
评测任务
  -> 场景适配器
  -> Agent Runtime
  -> 模型调用或工具调用
  -> Trace 记录
  -> 评分与指标聚合
  -> 对比报告
  -> 离线 Replay
```

评测运行器使用和普通执行相同的生产 Runtime。Replay 会加载已经完成的工件，
校验哈希、字节数和事件一致性，然后在不访问外部模型或工具的情况下重建运行。

## 环境要求

- Node.js 22.5.0 或更高版本
- npm 11 或更高版本
- Git

当前项目使用 Windows PowerShell 完成验证。

## 快速开始

```powershell
git clone https://github.com/Xiaoxiaocaiii/MyPiiii.git
Set-Location MyPiiii
npm ci
npm run demo
```

Demo 会自动编译项目，运行两组配置，输出对比结果，并回放代表性样本。
预期结果如下：

```text
Dataset: repo-qa-structure@v1
Baseline score pass rate: 1
Ablation score pass rate: 0.95
Regression samples: repo-qa-01
```

如果希望保留生成的运行工件，可以指定一个新的输出目录：

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
npm run dev -- demo --output ./artifacts/demo-01
```

从已有工件中离线回放样本：

```powershell
npm run dev -- replay --demo ./artifacts/demo-01 --variant baseline --case repo-qa-01
npm run dev -- replay --demo ./artifacts/demo-01 --variant ablation --case repo-qa-01
```

## 可选的真实模型测试

标准 Demo 不需要 API Key，也不需要网络连接。如果要运行可选的 OpenAI
Adapter 契约测试：

```powershell
Copy-Item .env.example .env
```

在 `.env` 中设置 `RUN_REAL_MODEL_TESTS=1`、`OPENAI_API_KEY` 和
`OPENAI_MODEL`，然后运行：

```powershell
npm run test:real-model
```

可以使用 `OPENAI_RESPONSES_ENDPOINT` 覆盖默认的 Responses API 地址。
`.env` 已被 Git 忽略，不应提交到仓库。

## 质量检查

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:fresh
npm run test:stability
npm run verify
```

当前版本共有 332 项测试通过，最近一次本地验证的语句覆盖率为 96.51%，
分支覆盖率为 90.35%。

## 项目结构

```text
src/
|-- core/             # 配置、Runtime、模型、工具和上下文核心
|-- observability/    # Trace、存储、完整性校验和 Replay
|-- eval/             # 数据集、评分器、运行器、指标和报告
|-- scenarios/        # 可替换的任务场景适配器
|-- cli.ts
`-- bin.ts
test/unit/             # 单元测试和契约测试
scripts/               # 集成测试和验证脚本
docs/                  # 复现说明和设计决策
artifacts/             # 生成工件，除 README 外均被忽略
```

## 当前范围

本项目专注于本地单 Agent 评测闭环，暂不包含：

- Web 或 HTTP API
- 多 Agent 编排
- 长期记忆或 RBAC
- 动态插件和命令执行工具
- 远程工件存储
- 远程模型的 Token 级复现

当耗时、Token、价格或工具错误缺少可信证据时，系统会标记为
`unavailable`，不会伪造为零。

详细的实验身份、工件结构和已知限制请查看
[发布与复现说明](docs/release-and-reproduction.md)。
项目为何保持 CLI 形态，请查看
[Web/API 范围决策](docs/web-api-decision.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。
