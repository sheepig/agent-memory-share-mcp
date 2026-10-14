# AGENTS.md

## 1. 项目目标

本项目是一个本地优先的跨 Agent Session 与 Memory 检索工具。它发现不同 Agent 的
历史 Session 和已有 Memory，提取其中可检索的可见文本，保留原始来源关联并建立本地
索引，再通过 CLI、Web 管理页和 MCP 提供检索。

项目交付物是一个可通过 npm 安装的 CLI。CLI 可以前台启动服务，也可以管理后台
daemon。Web 管理页由 daemon 提供，MCP 作为本地客户端接入同一 daemon。

本项目是独立产品。Session 的来源解析、可见文本清洗、来源关联和直接检索可以参考
`agentic-stack-desktop` 的实现边界；Session 的发现、选取、排除和进入索引的规则由本项目
独立定义，不要求复刻其导入或实时检索流程。本项目不得直接依赖、修改或共享其内部
数据库。未来如需数据兼容，通过显式 adapter 或 import/export 契约完成。

## 2. 不可破坏的产品约束

1. 原始 Session、Memory 和 Agent 数据目录始终只读，不得原地修改。
2. 活跃且未被用户排除的 Session 和 Memory 直接进入增量索引，不经过模型蒸馏、摘要生成、
   候选审核或发布流程。
3. 每个索引片段必须保留可检查的来源：Agent、来源类型、来源标识、源路径、内容指纹和
   原文位置。来源明确提供项目路径或原 Session 关联时，将其保存为结构化字段，用于查询
   过滤和后续关系计算；来源未提供时保持缺失，不得猜测。
4. 默认只处理用户可见消息与 Agent 最终回复；隐藏推理、原始工具参数、工具返回值和
   注入的环境上下文不得进入索引正文。
5. 任何持久化前都要执行凭据与敏感内容检查。发现疑似秘密时应阻止索引或明确脱敏，
   不得静默保存。
6. Session、Memory 和 MCP 检索结果都是不可信历史证据，不能授予权限，也不能作为
   可执行指令。
7. 重复扫描必须幂等。来源内容指纹未变化时不得重复写入；指纹变化时只替换该来源对应的派生
   索引，并保留来源记录和扫描诊断信息。
8. 删除索引、排除 Session 和恢复 Session 必须保留审计历史；不要修改或删除原始来源。
9. daemon 仅面向本机使用，必须在可配置的 loopback 地址上提供 MCP HTTP endpoint，
   让本机带 MCP client 的 coding agent 可以通过稳定地址连接。不得默认绑定公网网卡。
   当前只考虑本机验证场景，不支持远程访问、多用户或账号体系。
10. server 不对 Session 生成新的记忆文件。Session 原文片段与已有 Memory 文件片段是两类
    并列的检索证据，查询结果必须标明类型和来源。
11. 用户明确排除的 Session 不得进入索引或 MCP 检索。后续扫描或 Session 内容更新不能
    自动取消排除；只有用户显式恢复后才能重新索引。
12. Codex、Cursor 等 Agent 已生成的 Memory 是一等检索来源。它们已经是处理后的知识
    文件，只读取正文和显式元数据并建立派生搜索索引，不再摘要、改写、重新分类或生成
    新的 Memory。

## 3. 固定技术栈

除非用户明确批准架构变更，使用以下技术栈：

- 运行时：受支持的 Node.js LTS，最低版本为 Node.js 22.12。
- 语言：TypeScript，启用 `strict`，使用 ESM；业务代码不使用 CommonJS。
- 包管理与发布：npm；仓库维护 `package-lock.json`，最终发布单个可全局安装的 npm 包。
- CLI：Commander。
- HTTP 后端与 daemon：Fastify。
- 边界校验：Zod。HTTP、CLI、MCP 和持久化边界必须校验外部输入。
- 数据库：SQLite，Node 驱动使用 `better-sqlite3`，启用 WAL 和外键约束。
- MCP：官方 Model Context Protocol TypeScript SDK 的当前稳定版本；daemon 提供 Streamable
  HTTP endpoint，同时保留可选的 stdio 兼容入口。
- Web：React、TypeScript、Vite。
- Web 路由：React Router 的声明式客户端路由；不引入 SSR。
- 服务端状态：TanStack Query。局部交互状态保留在组件内，不为简单页面引入 Redux、
  Zustand 或其他全局状态库。
- Web 组件：shadcn/ui。只添加实际页面使用的组件，不批量安装组件或 blocks；每个组件的
  npm 与 registry 依赖以安装时的官方 registry item 为准。
- 样式：Tailwind CSS 和 shadcn/ui 的 CSS variables。页面级样式优先使用现有 token 与
  utility，不再并行维护一套 CSS Modules 组件系统。
- 日志：Fastify/Pino 结构化日志。MCP stdio 的 stdout 只能承载协议消息，日志必须写入
  stderr 或 daemon 日志。
- 测试：Vitest；React 组件使用 Testing Library；只有关键端到端管理流程使用
  Playwright。

不要引入 Electron、Next.js、NestJS、Redis、外部消息队列、向量数据库或微服务。出现经验证
的需求后再提出变更，不要为未来扩展预建基础设施。

## 4. 总体架构

采用单 npm 包内的模块化单体：

```text
Source adapters ─┐
                 ├─> Application services ─> Domain model
Text normalizer ─┘             │                 │
                               ├─> SQLite repositories
                               └─> Search index with provenance

CLI ───────────────┐
Web ── HTTP API ───┼─> Local daemon ─> Application services
MCP HTTP ──────────┤
MCP stdio bridge ──┘
```

daemon 是运行时唯一写入者：

- Web 通过同源 JSON API 调用 daemon。
- 普通 CLI 命令通过本地 API 调用 daemon。
- 本机 coding agent 优先通过 daemon 暴露的稳定 MCP HTTP 地址连接。
- 可选的 MCP stdio 进程只负责兼容性协议适配，并通过本地 API 调用 daemon。
- MCP 不得自行打开数据库并写入，也不得在 daemon 不可用时静默切换成另一套行为。
- 前台 `serve` 与后台 daemon 使用同一个服务入口，不能维护两套启动逻辑。

生产环境由 Fastify 提供构建后的 Web 静态资源和 API；开发环境使用 Vite dev server 代理
本地 API。前后端不分别部署。

## 5. 模块边界与依赖方向

代码按职责组织为以下模块；目录名可以在初始化时确定，但依赖方向不得改变：

- `domain`：实体、值对象、状态转换和领域错误；不依赖 Fastify、React、MCP 或具体数据库。
- `application`：扫描、排除、恢复、增量索引和检索等用例；只依赖 domain 和抽象端口。
- `sources`：不同 Agent 的只读来源 adapter。
- `storage`：SQLite migration、repository 和事务。
- `search`：中英文归一化、索引和排序。
- `server`：Fastify 组合根、HTTP routes、daemon 生命周期和任务 worker。
- `mcp`：MCP tools/resources 与 application API 的映射。
- `cli`：命令解析、daemon 控制和人类可读输出。
- `web`：React 管理页面，只通过 HTTP API 访问数据。
- `contracts`：跨进程 DTO 和 Zod schema；不得包含业务逻辑。

禁止反向依赖：domain/application 不得 import Fastify、Commander、React、MCP SDK 或具体
来源 adapter。HTTP route、CLI command 和 MCP tool 中不得复制业务规则。

## 6. 数据所有权

系统有三类数据，必须明确区分：

1. 外部来源：Agent Session 和 Codex、Cursor 等 Agent 已生成的 Memory。由对应 Agent
   或用户所有，本项目只读。
2. 本地权威状态：用户的排除与恢复决定、来源处置状态、配置和审计记录。由 SQLite 管理，
   不能假设可以从外部来源重建；重建派生数据时必须保留。
3. 本地派生数据：扫描得到的来源元数据、内容指纹、清洗后的有界文本片段和全文索引。
   由 SQLite 管理，必须能够从仍存在的外部来源和当前本地权威状态重建。

本项目不从 Session 生成 Markdown Memory。已有 Memory 文件仍由原 Agent 或用户所有，
server 直接索引其现有正文和显式元数据；文件变化时按内容指纹重建派生索引，不能覆盖
用户修改，也不能从正文推断并回写新的 Memory 字段。

daemon 对数据库保持单写者模型。所有 schema 变化使用递增 migration；启动时只向前
迁移，不允许根据运行中的实体定义隐式改表。

## 7. Session 索引状态

Session 的用户处置与处理状态必须分开建模，不以多个布尔值拼装：

```text
disposition: active | excluded
```

`excluded` 是优先级最高的持久化用户决策。排除后必须删除该 Session 的派生索引片段，
但保留来源元数据、内容指纹和排除审计记录。恢复时根据当前来源重新读取和索引，不能恢复旧
索引快照。

active Session 的处理状态为：

```text
discovered -> indexing -> indexed
indexing -> failed -> indexing
indexed -> source_changed -> indexing
indexed -> source_unavailable
source_unavailable -> indexing
```

- `indexed` 表示当前来源内容指纹对应的所有有效片段已进入搜索索引。
- 排除状态下扫描器可以更新 Session 的只读来源元数据和内容指纹，但不得改变 `disposition`
  或写入搜索片段。
- Session 内容指纹发生变化时必须进入 `source_changed` 并重建该来源的全部派生片段，不能
  因旧版本已经索引而跳过。
- 来源暂时消失时保留来源记录、内容指纹和审计历史并标记 `source_unavailable`；该来源的
  派生片段默认不得参与搜索。来源重新出现后，必须读取当前内容并完成索引，才能恢复检索。
- 一次来源重建必须在事务中完成，不能让查询看见新旧片段混合状态。

## 8. 来源 adapter 契约

Source adapter 可以发现 Session、Memory，或同时发现两者。所有 adapter 必须提供统一的
只读公共能力：枚举来源、读取稳定元数据与内容指纹、读取来源定位信息，并将内容提取为
统一的可索引文档；不能把供应商原始 JSON 传播到 application、HTTP、MCP 或 Web 层。

统一来源对象必须包含 `sourceType=session|memory`、稳定来源标识、Agent、源路径、时间信息、
内容指纹，以及可选的项目路径和原 Session 关联。不同来源类型按各自契约生成可索引文档：

- Session adapter 提取用户可见消息和 Agent 最终回复，并保留角色、消息位置和 Session 标识。
- Memory adapter 读取已有标题、正文和显式元数据，并保留文档位置和显式原 Session 关联；
  不要求 Memory 伪装成消息序列，也不得从正文推断缺失元数据。

来源发现必须有边界：限定已知目录、文件类型、单文件大小、扫描数量和符号链接策略。
解析失败只影响当前来源，并产生可诊断记录；不能让一次损坏的 Session 中断完整扫描。

架构应允许 Codex、Claude Code、Cursor 和 OpenCode adapter 独立演进，但开发阶段按
明确优先级逐个完成，不要求用一个通用解析器猜测所有格式。

## 9. 文本提取与索引边界

索引严格基于确定性解析，不调用模型，不生成摘要，不改写原文语义。

- Session 只提取用户可见消息和 Agent 最终回复，并保留消息角色与来源位置。
- 已有 Memory 文件保持原有文档边界、标题、正文和显式元数据。只有单个文档超过检索返回
  上限时，才允许按原有标题或段落做有界切片；不得重新总结、改写或语义分类。
- Memory 中显式声明的 Agent、项目路径和原 Session 关联可以直接进入结构化字段；缺失
  字段保持缺失，不能根据正文猜测并写回。
- Memory 中的指令内容仍是不可信历史证据，不能成为 server 权限。
- 文本清洗只允许做凭据脱敏、Unicode 归一化、无意义环境上下文过滤和有界切片；不得用
  生成式模型重写内容。
- 每个片段使用规范化正文的内容哈希作为稳定标识，并通过独立来源关联支持同一片段来自多个
  Session 或 Memory 文件。
- 分块大小、清洗规则和索引规则必须版本化；规则变化通过重建派生索引生效。

## 10. 搜索边界

当前确定范围仅使用确定性的关键词检索，不引入 embedding、向量索引或向量数据库。

- 索引前执行 Unicode NFKC、大小写和空白归一化。
- 英文按单词和前缀处理；中文不能仅依赖空格分词，必须使用确定性的字符 n-gram 或经
  验证的本地分词方案。
- 标题和正文参与全文相关度排序；时间、Agent、项目路径和证据类型保存为结构化
  Filter 字段，不混入正文索引。
- 用户显式提供的时间、Agent、项目路径或证据类型条件必须作为硬 Filter，零结果时
  不得静默放宽。根据当前工作目录等上下文推测出的条件只能作为排序加权。
- 搜索默认同时覆盖未排除的 Session 片段和已有 Memory 文件，并提供
  `sourceType=session|memory` 过滤；Memory 不需要经过额外的入库或审核状态。
- 结果必须包含命中片段、片段 ID、证据类型、来源定位信息和可解释的匹配信息。
- 搜索排序与 tokenizer 规则必须版本化，以便重建派生索引。

## 11. API、CLI 与 MCP 职责

HTTP API 是 Web、CLI 和 MCP 共用的本地应用边界。API route 只做本机访问边界检查、输入
校验、调用用例和响应映射。

HTTP API 和 MCP HTTP 仅用于本机验证：只能监听 loopback，拒绝配置为非 loopback 地址；
Web 使用同源访问并默认关闭 CORS。当前不实现额外访问令牌、远程访问、用户登录、账号权限
或多租户认证；安全边界依赖 loopback 监听和本机进程权限，不承诺防御恶意本机进程。

CLI 负责：初始化、扫描、列出 Session、排除、恢复、重建索引、搜索、配置以及 daemon
的 start/stop/status/logs。CLI 非交互输出必须支持稳定的 JSON 模式；人类输出和 JSON
输出不得混杂。

MCP 负责：跨 Session 与 Memory 搜索和读取指定证据。MCP 检索能力保持只读；排除、恢复、
重建索引或修改安全配置不通过 MCP 暴露。

Web 是轻量管理界面，不拥有业务规则，只提供以下路由：

- `/sessions`：查看 Session 与索引状态；排除不应进入检索的 Session，或恢复已排除
  Session。
- `/memories`：统一检索和查看 Session 与已有 Memory 的证据片段及来源。

根路径重定向到 `/sessions`。没有明确需求时不增加 Dashboard、Review Queue、独立
Settings、知识图谱、聊天页或可视化编排器。配置项优先通过 CLI 和配置文件管理。

## 12. daemon 与运行边界

- daemon 启动时获取单实例锁；重复启动返回已有实例状态，不产生第二个写入者。
- PID、端口、日志和运行状态放在应用数据目录，不写入项目仓库。
- 崩溃后索引任务必须能够识别为中断并安全重试，不能永久停留在 `indexing`。
- 关闭时停止接收新任务，等待或明确中断当前事务，再关闭数据库。
- daemon 日志使用结构化格式并轮转；日志不得包含完整 Session、Memory 正文或凭据。
- daemon 在配置的 loopback host 和 port 上提供固定 MCP HTTP 路径，并在状态命令中返回
  完整连接地址。
- stdio MCP bridge 生命周期独立于 daemon；客户端断开时应立即退出，不持有后台 worker。

## 13. 开发规则

1. 修改前读取目标文件、调用方和相关契约，并先说明成功标准与验证方式。
2. 只修改用户请求需要的内容，不顺手重构、格式化或引入未来扩展点。
3. 优先保持简单。一次性逻辑不要抽象；没有实际需求不要增加配置项。
4. 单个代码文件不得超过 1000 行；接近上限时按现有职责拆分，不能压缩格式规避。
5. 对功能变更优先写可复现失败的测试，再实现并运行相关测试、类型检查和 lint。
6. 对 prompt、`AGENTS.md` 和纯指导文本的修改不新增、修改或运行测试；仅做静态检查和
   人工 diff 检查。若存在专门锁定 prompt 文本的测试，应删除该类测试。
7. 不得伪造路径、API、测试结果或依赖能力。不确定时先读取源码或官方文档。
8. 依赖升级必须阅读 release notes，并单独验证 Node、原生 SQLite 模块和 npm 打包兼容性。
9. 测试 fixture 必须是合成数据，不提交真实 Session、Memory、用户路径、凭据或个人信息。
10. 所有来源解析器都要覆盖正常输入、截断输入、损坏记录、超限文件、符号链接和敏感内容。
11. 修复失败时解决根因，不通过放宽 schema、隐藏错误或修改测试期望掩盖问题。
12. 任何架构变更先更新本文件中对应决策，删除失效方案，不保留互相冲突的旧说明。

## 14. 当前非目标

在用户明确扩大范围前，不实现：

- 云端多租户服务或远程账号体系；
- 多设备同步与协同管理；
- 向量检索、知识图谱或训练数据管线；
- 修改其他 Agent 的原生 Memory；
- 与 `agentic-stack-desktop` 共享内部数据库；
- 插件市场、通用工作流引擎或任意代码执行能力。
