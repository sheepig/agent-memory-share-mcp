# Session 自动索引验证记录

日期：2026-10-24。环境：Apple M1 Pro、32 GiB 内存、macOS arm64、Node.js v22.23.1。
测试数据均为合成来源；原始 Agent 数据与产品 daemon 数据库未用于写入验证。

## 功能与交付检查

- `npm test`：50 个文件通过，199 项测试通过；默认跳过的 2 项 tokenizer 集成测试随后指定
  本地缓存单独运行，2 项均通过。
- `npm run typecheck`、`npm run build`、新增负载脚本的独立 strict 类型检查通过。
- Playwright：4 项流程通过，覆盖自动纳入、剔除后无命中、恢复和 hybrid 搜索。
- 独立 agent-browser 会话验证了容量展示、剔除与恢复；临时服务和浏览器均已关闭。
- npm 打包预览未包含数据库、来源正文、运行数据或模型缓存。
- 人工 diff 与静态检查确认 Session 条数上限已从方案中删除，容量约束仅按 Agent 片段数管理。

## 大量候选的调度验证

使用仓库内 `scripts/verify-session-load.ts`，四个 Agent 均分候选，每个候选生成一个片段，
各 Agent 预算为 5,000。下面的时间不包含文件解析、tokenizer、模型推理或 HTTP；定时器
间隔仅用于观察事件循环响应性。RSS 在同一个 Node 进程中采样，后续档位包含前序堆保留。

| 候选总数 | 最终片段数 | 处理耗时 | 最大定时器间隔 | RSS 峰值 |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1,000 | 0.94 秒 | 12.3 ms | 139.0 MiB |
| 10,000 | 10,000 | 9.76 秒 | 26.7 ms | 209.7 MiB |
| 100,000 | 20,000 | 67.97 秒 | 26.6 ms | 215.1 MiB |

10 万条候选中，四个 Agent 各保留 5,000 个片段，其余 80,000 条候选处于容量等待。
未观察到长调度间隔，扫描 checkpoint 全部完成，报告内源码指纹与最终实现一致。
单独的 5,000→100 片段预算收敛验证耗时约 1.29 秒，逐步释放时最大步骤约 1.5 ms；
该记录对应容量模块的同一源码指纹。

## 真实本地模型与重启

使用已缓存的固定 Jina q8 模型，关闭远程模型请求。3 个合成 Session、2 个片段预算：

- 首次健康接口可用约 52.6 ms，完成索引约 472.6 ms。
- 仅为最终纳入的 2 个片段生成向量，容量外的旧来源未先生成向量。
- 重启健康接口可用约 9.7 ms，重启扫描的正文向量生成数为 0。
- 重启后的首次语义查询约 282.7 ms，返回 2 条结果；该时间包含模型重新加载。
- 进程观察到的峰值 RSS 约 604.3 MiB。4 次健康请求的最大耗时约 4.7 ms。

这是使用缓存模型的小规模单次冒烟验证，不包含模型首次下载，不能外推为完整容量下的
HTTP 延迟保证。仍需按真实正文长度、Memory 规模、模型与查询并发评估部署资源。

## 产物与复现

源码仓库中运行：

```bash
caffeinate -i node --import tsx scripts/verify-session-load.ts 1000 10000 100000
```

本地证据放在已忽略的 `.agent-memory-share-mcp/verification/session-auto-indexing/`：

- `source-worker-load.json`：最终调度负载，包含源码指纹与容量统计。
- `capacity-trim.json`：片段预算收敛测量。
- `real-model.json`、`real-model-smoke.mts`：本地模型验证及脚本。
- `browser-qa.json`、`sessions-capacity.png`：实际页面交互记录与截图。
- `package-dry-run.json`：打包内容预览。

早先存在长调度间隔的原始记录保留为 `source-worker-load-interrupted-timing.json`，未用于上述
耗时结论，也未扣除估计暂停时间。最终记录在保持机器唤醒的条件下完整重跑。
