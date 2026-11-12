# com-ai：面向中文 AI 开发者的 Agent 资产市场

> 本文档是方案共识的完整表述，已发布为 GitHub Issue #1（TOKEN-DL/com-ai）。仓库内副本位于 `docs/specs/`，内容与 Issue 同步。

## Problem Statement

中文 AI 开发者每天在 Claude Code / Cursor 等工具里遇到同一个问题：**能力已经存在，但找不到、看不懂、装不上。**

具体表现为四个断裂：

1. **Skill 找不到。** skills.sh 上最受欢迎的 skill 是 `vercel-labs/skills/find-skills`（累计 421 万次安装）——一个"帮你找 skill"的元技能排到第一，说明"找到对的 skill"本身就是刚需。但 skills.sh 的条目描述绝大多数只回答了"这个 skill 做什么"，没有回答"我什么时候该用它"和"我该怎么用"。中文用户还要额外跨过一层语言障碍。
2. **MCP 装不上。** MCP server 的安装本质上是一段 `mcpServers` JSON，但这段 JSON 需要知道环境变量名、传输方式、端口、认证方式。官方 registry 的数据最规整却完全没有热度；Smithery / mcp.so 有热度但字段割裂；PulseMCP 条款最受限。开发者要在三四个站点之间来回拼凑。
3. **Prompt 资源散。** 视频、音乐、图片生成的提示词几乎不存在于通用提示词库里——它们分散在 GitHub 各自的 CC0 仓库里，没有分类、没有中文说明、没有检索。PromptBase / FlowGPT 这类商业站点条款禁止爬取且内容有版权，不可直接再分发。
4. **资讯时效。** 国际大厂的模型发布与研究进展分散在各家博客与 RSS 里，Anthropic 甚至没有官方 RSS；国内厂商（DeepSeek、智谱、Kimi、豆包）多数是无路由的 SPA 空壳，静态抓取拿不到任何条目。

现有的三个同级项目（`dl-resume`、`video-downloader`、`delong-hot-monitor`）各自解决了局部问题，但没有一个是"资产市场"：没有统一的三类资产模型、没有跨类型检索、没有"何时用/怎么用"的中文说明、没有版本与依赖。

## Solution

建一个**面向中文 AI 应用开发者的 agent 资产市场**，把散落各处的 Skill、MCP Server、Prompt 三类资产收进一个可搜索、可理解、可一键取用的地方，并在此之上形成开发者之间的经验交流。

分阶段交付：

- **一期**：Skill 库为主，含浏览、搜索、LLM 生成的中文简介（何时用/怎么用）、一键复制安装命令与 SKILL.md、游客态收藏点赞、邮箱验证登录与评论。基础设施按三类资产统一设计。
- **二期**：MCP 库与 Prompt 库接入统一检索；用户发布自己的资产；版本管理与一键更新；依赖声明与冲突检测。
- **其后独立阶段**：AI 资讯模块；社区独立形态。在线试跑沙箱与评分分成已砍掉。

**核心差异化**：在每一类资产上补上"**何时用 / 怎么用**"的中文说明。这不是翻译，是用 LLM 对原始 `SKILL.md` / MCP 工具定义做语义理解后的再加工——也正因如此，条目来源必须遵守许可证分层，且生成内容必须标注 AI 生成与原作者版权。

## User Stories

### 一、资产发现与理解

1. 作为中文 AI 应用开发者，我想按自然语言搜索技能（如"批量处理 PDF"），以便快速找到能解决当前问题的工具，而不是逐个翻阅分类。
2. 作为中文 AI 应用开发者，我想在搜索结果里看到每个技能的"何时该用"描述，以便判断它是否匹配我的场景，而不只是知道它叫什么名字。
3. 作为中文 AI 应用开发者，我想在搜索结果里看到"怎么用"的具体步骤与安装命令，以便复制后立刻在 Claude Code / Cursor 里跑起来。
4. 作为中文 AI 应用开发者，我想看到该技能的使用量或热度排名，以便在多个同类技能之间做选择。
5. 作为中文 AI 应用开发者，我想看到技能的原始仓库地址与许可证标识，以便确认可信度与商用合规性。
6. 作为中文 AI 应用开发者，我想看到该技能当前版本与最近更新时间，以便判断它是否还在维护。
7. 作为中文 AI 应用开发者，我想查看某个技能引用的附属文件（如 `REFERENCE.md`、`scripts/`），以便知道它是不是一个"重量级"技能。
8. 作为中文 AI 应用开发者，我想按分类、宿主（Claude Code / Cursor / Codex / Gemini…）、许可证、是否有官方版本筛选技能，以便缩小范围。
9. 作为中文 AI 应用开发者，我想按字母、热度、更新时间三种方式排序，以便在"找著名的"和"找新鲜的"之间切换。
10. 作为中文 AI 应用开发者，我想看到一个技能被哪些人收藏、点赞了多少，以便判断社区认可度。
11. 作为中文 AI 应用开发者，我想收藏技能以便下次快速找到，以便不必重新搜索。
12. 作为中文 AI 应用开发者，我想在我收藏的列表里看到技能的更新提醒，以便及时升级。

### 二、Skill 库（数据与展示）

13. 作为访问者，我想看到全站最受欢迎的技能榜单，以便快速了解当前生态热点。
14. 作为访问者，我想看到近期增长最快的技能，以便发现新出现的优质技能。
15. 作为访问者，我想看到官方出品或高信誉作者的技能，以便降低试用成本。
16. 作为访问者，我想在技能详情页看到完整的 `SKILL.md` 原文，以便确认它真的解决了我的问题。
17. 作为访问者，我想一键复制技能安装命令，以便直接粘贴到终端。
18. 作为访问者，我想一键复制整份 `SKILL.md`，以便手动放进自己的 skills 目录。
19. 作为访问者，我想知道这个技能支持哪些宿主，以便确认在自己的编辑器里可用。
20. 作为访问者，我想看到该技能用到的外部依赖或环境变量，以便提前准备。
21. 作为访问者，我想看到简介是"AI 生成"还是"人工撰写"，以便判断该信任到什么程度。

### 三、MCP 库（二期）

22. 作为中文 AI 应用开发者，我想按能力搜索 MCP server（如"查文档"、"发邮件"），以便找到能接进我项目的工具。
23. 作为中文 AI 应用开发者，我想看到该 MCP server 暴露了哪些工具及其参数结构，以便知道它能做什么、要传什么。
24. 作为中文 AI 应用开发者，我想看到它需要哪些环境变量及是否必填，以便配置时不踩坑。
25. 作为中文 AI 应用开发者，我想直接拿到可粘贴的 `mcpServers` 配置片段，以便一键接入。
26. 作为中文 AI 应用开发者，我想知道该 server 是本地 stdio 传输还是远程 HTTP，以便判断部署方式。
27. 作为中文 AI 应用开发者，我想在安装前看到它是否与已安装的 server 冲突（端口或环境变量名撞车），以便避免我的 agent 启动失败。
28. 作为中文 AI 应用开发者，我想看到该 MCP server 的仓库 star 数与最近更新日期，以便判断活跃度。

### 四、Prompt 库（二期）

29. 作为内容创作者，我想按模态浏览提示词（文本 / 图片 / 视频 / 音乐），以便找到适合我当前创作形态的那一类。
30. 作为内容创作者，我想看到每条提示词的适用场景说明，以便知道它能产出什么效果。
31. 作为内容创作者，我想看到提示词的原始来源与许可证，以便确认能否商用。
32. 作为内容创作者，我想按模态 + 工具/模型筛选提示词（例如专门为 Flux、Seedance 这类模型写的），以便得到可直接用的结果。
33. 作为内容创作者，我想一键复制提示词原文，以便直接粘贴到生成工具里。
34. 作为内容创作者，我想看到社区对提示词的补充说明（参数怎么调、负面提示词怎么写），以便少走弯路。

### 五、互动与社区

35. 作为游客，我想无需注册就能给技能点赞，以便先参与再决定要不要注册。
36. 作为游客，我想无需注册就能收藏技能到本地，以便保持轻量使用。
37. 作为已验证用户，我想评论一个技能，补充我的实际用法与踩坑经验，以便帮助后来者。
38. 作为已验证用户，我想回复别人的评论以便形成讨论串。
39. 作为已验证用户，我想发布自己的 Skill 或 MCP server，以便让它进入市场被使用。
40. 作为已验证用户，我想看到我发布资产的审核状态与审核意见，以便知道被拒的原因。
41. 作为已验证用户，我想看到我发布资产的版本历史与更新日志，以便追踪变更。
42. 作为已验证用户，我想收到我已安装/收藏的资产有新版本的提示，以便及时升级。
43. 作为访问者，我想看到从某个技能自动派生的"使用场景卡片"（如"想批量处理 PDF 就用这个"），以便从具体任务而非工具名开始探索。
44. 作为访问者，我想在场景卡片上直接跳转到对应技能详情，以便顺着线索继续了解。
45. 作为访问者，我想举报违规或垃圾内容，以便维护社区质量。
46. 作为已验证用户，我想编辑生成的简介或补充说明，以便纠正错误内容。

### 六、AI 资讯（后续阶段）

47. 作为 AI 开发者，我想看到各家大厂发布新模型的资讯，以便第一时间跟上能力边界的变化。
48. 作为 AI 开发者，我想看到大厂研究博客的新进展解读，以便理解技术方向而不只是知道标题。
49. 作为 AI 开发者，我想看到新概念（如 Harness、Loop、自进化）的解释文章，以便跟上行业词汇的演化。
50. 作为 AI 开发者，我想按重要性过滤资讯，以便不被噪音淹没。
51. 作为 AI 开发者，我想订阅每日/每周精选摘要，以便用最少时间掌握要点。
52. 作为中文用户，我想看到国内厂商（DeepSeek、智谱、Kimi、豆包）的动态，以便不被英文信息差落下。
53. 作为 AI 开发者，我想把某条资讯分享成社区帖子并附上我的看法，以便参与讨论。

### 七、平台运营

54. 作为平台运营者，我想按许可证自动分层存储内容，以便在合规前提下最大化可检索内容。
55. 作为平台运营者，我想知道每个资产的来源与同步时间，以便排查数据陈旧问题。
56. 作为平台运营者，我想在内容源解析失败时收到告警，以便及时修复而不是静默产出空结果。
57. 作为平台运营者，我想控制采集频率，避免对外部站点造成压力。
58. 作为平台运营者，我想批量重跑简介生成（例如换了模型或改了提示词），以便修正质量问题。

## Implementation Decisions

### 1. 交付形态与部署

- 平台是**agent 资产市场**，终态包含浏览、搜索、一键取用、收藏点赞、评论、发布、版本管理、依赖声明与冲突检测。**永久不做**：在线试跑沙箱、评分与分成、依赖自动求解器（只做查表式冲突检测）。
- 能力分期交付：
  - **一期** = 浏览 + 搜索 + 一键取用 + 收藏点赞 + 发布 + 邮箱登录 + 评论
  - **二期** = MCP 库 + Prompt 库 + 版本管理 + 一键更新 + 依赖声明与冲突检测
  - **其后独立阶段** = AI 资讯模块 + 社区独立形态
- 部署形态为**自建 Docker Compose 单机**：Postgres、应用服务、定时任务容器、Caddy 反向代理。不使用 Vercel、不使用 Serverless，文件持久化与数据库完全自持。
- 采集器与 Web 应用**同语言同进程**（TypeScript / Node），不引入独立 Python 服务。

### 2. 技术栈

- Web 与 API：Next.js（App Router）+ TypeScript。
- ORM 与迁移：Prisma + Postgres。
- 采集：TypeScript，使用 `rss-parser`（RSS/Atom）、`cheerio`（HTML 静态解析）、`node-cron`（调度）。
- LLM：DeepSeek（OpenAI 兼容协议），用于生成中文简介与场景卡片。
- 复用来源：新建独立仓库，不 fork；将 `DL-monitor` 的源适配器、`safeFetchJSON` 失败容错、每源独立 cron、3-tier 保留策略、质量阈值过滤，与 `delong-hot-monitor` 的 RSS 适配器、`SourceAdapter` 契约、OpenAI 兼容 LLM 封装（含失败不抛错的降级）、通知层 HTML/Markdown 消毒逻辑，**复制**进新仓库。不抽成跨仓库公共包。

### 3. 数据模型

采用**统一资产主表 + 类型判别列 + 各类 1:1 扩展表**：

- `Asset`：`kind`（SKILL | MCP | PROMPT）、`slug`、`displayName`、`summaryZh`、`summarySource`（LLM | HUMAN | TEMPLATE）、`repoOwner`/`repoName`/`repoUrl`、`license`（SPDX id）、`contentTier`（FULL | METADATA_ONLY）、`upstreamUrl`、`stars`、`installs`、`heatScore`、`sourceId`、`publishedAt`、`lastSyncedAt`、`isOfficial`。
- `SkillDetail`（1:1）：`frontmatter`、`whenToUse`、`howToUse`、`installCmds`（按宿主）、`hosts[]`、`skillPath`、`extraFiles[]`。
- `McpDetail`（1:1）：`transport`、`packages[]`、`remotes[]`、`tools[{name, description}]`、`envVars[]`、`ports[]`、`configJson`。
- `PromptDetail`（1:1）：`modality`（TEXT | IMAGE | VIDEO | MUSIC）、`act`、`promptBody`、`forDevs`、`contributor`。
- `AssetVersion`：`version`（上游 commit sha 或平台 semver）、`origin`（UPSTREAM | PLATFORM）、`changelog`、`snapshot`（仅 FULL 档位存正文快照）。
- `AssetDependency`：`fromId`、`toId`、`kind`、`constraint`。
- 互动：`Favorite`、`Like`（游客态，基于设备指纹 + IP 限流）、`Comment`（需登录）。
- 用户：`User`（邮箱验证）、`Session`、`UserPublishedAsset`、`UserInstall`。

选择理由：跨类型搜索、推荐、收藏、点赞只需查询主表；类型差异字段放在扩展表，避免 JSONB 污染，同时保留结构约束。

### 4. 采集器框架

- 定义统一的源适配器契约：输入源配置，输出规范化条目数组；单源异常不得阻塞其他源。
- 内置失败容错：请求超时、指数退避重试（沿用已验证的 3 次退避策略）、限流退避、UA 轮换池。
- **每个数据源独立 cron**，而非统一轮询——高频源（榜单）与低频源（周更语料）节奏不同。
- 保留策略三档：热（窗口期内）→ 归档（超期但高热度，保留于库、前端隐藏）→ 删除（超期且低热度，物理删除）。
- 采集器**只允许访问公开页面路径与官方 API**，代码中不写入任何被 robots.txt 标记为 `Disallow` 的 `/api/` 路径——以架构约束保证合规，而非依赖自觉。

### 5. 三条采集管道

**Skill 管道**
- 目录来源：skills.sh 首页榜单（内嵌 600 条，含 installs 与 8 周趋势）与 `sitemap-skills-1/2.xml`（2 万条 URL）。**不使用**其 `/api/` 路径（官方 v1 API 需 Vercel OIDC，无 token 返回 401；且 robots 禁止 `/api/`）。
- 正文来源：**回源 GitHub raw 拿原始 `SKILL.md` 与 frontmatter**（含 `name`、`description`、`license` 等），不解析 skills.sh 的 RSC 载荷。
- 热度：`skills.sh installs` 与 GitHub stars 加权。定义三个视图：累计安装量（all-time）、近期增速（trending）、每小时对比昨日同时段（hot）。

**MCP 管道**
- 权威来源：官方 `registry.modelcontextprotocol.io/v0/servers`（免鉴权），提供 `packages[].environmentVariables`、`runtimeArguments`、`transport` 等关键字段；请求时须指定 `version=latest`，否则会返回历史废弃版本（版本号按字符串比较而非语义版本比较）。
- 热度来源：**用 GitHub Search API 自算仓库 star 数**，不依赖任何第三方的热度字段。
- 辅助来源：Glama 详情页的 JSON-LD 中含 `SoftwareApplication` 与 `FAQPage`，FAQ 原文是生成"何时用"的高质量语料。
- 放弃 PulseMCP（Cloudflare 拦截、robots 禁止 AI bot、条款限定仅可引用）。

**Prompt 管道**
- 文本类：`f/prompts.chat` 的 `prompts.csv`（实测 10,471,671 字节、**2,898 条记录**、恒 5 列、0 脏行；提示词内容 CC0 1.0，但 GitHub `spdx_id` 是 `NOASSERTION`，**须按仓库覆盖**）；中文类：`CHENJIAMIAN/awesome-chatgpt-prompts-zh-CN`（CC0 1.0，prompt 在 `chatgpt_prompts-zh-CN.json`，实测 2,172 条）。
  - ⚠️ **此处曾写 `PlexPt/awesome-chatgpt-prompts-zh`（MIT / `prompts-zh.json` / 124 条）—— 实施时该仓库已 404（`GET /repos/...` 返回 Not Found，GitHub 上也搜不到同名仓库），改用同源的中文分支**：许可证更宽松（CC0 1.0，LICENSE 全文 + GitHub `spdx_id` 都认），README 明确写「本仓库的中文译文同样以 CC0-1.0 发布」。条数也从 124 变成 2,172。
- 视频/图片类**必须单独收集**（通用文本库里没有）：`YouMind-OpenLab/awesome-seedance-2-prompts`（106 条，CC BY 4.0，须署名）、`bytedance/Video-As-Prompt`（55 个 .txt，Apache-2.0）、`ZeroLu/awesome-seedance`（MIT）、`Anil-matcha/awesome-flux-3-api-prompts`（**无 LICENSE 文件** → 只能 METADATA_ONLY）、`wide-trace/open-higgsfield`（25 条在 `data.ts`，**无 LICENSE 文件** → 只能 METADATA_ONLY）。
- ⚠️ **通用 CSV 语料的 `type` 字段只有 TEXT / STRUCTURED / IMAGE，没有 VIDEO 与 AUDIO**；`act` 是标题不是分类。
- **音乐类已实测确认有可用来源，四模态覆盖不需要降级**（实测明细见 `.com-ai-context/verified-music-prompts.md`）：**本期只收零争议的 CC0/MIT 自建源** —— `samuelgrupolimex-prog/suno-style-recipes`（**564 条**，CC0 1.0 全文，字段含 bpm/weirdness/style_influence/structure）、`naqashmunir21/awesome-suno-prompts`（**272 条唯一**，CC0 1.0 全文；README 宣称「2,000+」实为虚高 7.4 倍）、`musegen/awesome-music-prompts`（**106 条**，MIT）、`yzfly/awesome-music-prompts`（23 条，MIT）、`suno-ai-farm/awesome-ai-music-prompts`（14 条，MIT，覆盖 Stable Audio / MusicGen / MusicFX 与四平台变体），合计 **979 条 FULL 档正文、零署名义务**。
  - 需按仓库覆盖（若收录）：`Anil-matcha/awesome-minimax-music-3-prompts`（21 条，实为 **CC BY 4.0**，`spdx_id` 却是 `NOASSERTION`）、`dimlyai/awesome-suno-resources`（实为 CC BY 4.0）、`NuNaught/suno-songwriting-skill`（实为 Apache-2.0）。
  - **体量大但授权弱、暂不收录的两个 HF 数据集**：`nyuuzyou/suno`（数据集卡声明 659,788 行，`cc0-1.0`）、`blanchon/udio_dataset`（约 132,000 条，`cc0-1.0` **仅覆盖编纂与 JSON metadata，不覆盖音频本体**）。两者均为**第三方抓取后由上传者单方贴 CC0**，原作者未授权，强度低于作者自建的 CC0 源。**本期只收零争议的 CC0/MIT 自建源**（上列合计 **979 条 FULL 档正文、零署名义务**）；这两个数据集留作后续增量的候选，须先解决授权强度问题。
  - 采集坑（必须遵守）：`nyuuzyou/suno` 的 `metadata_prompt` 实为**歌词**，真正可用的 style 提示词是 `metadata_tags`；该数据集含 `user_id`/`display_name`/`handle`/`avatar_image_url` 等**真实用户标识，必须全部丢弃**；`dawgshart/suno-prompt-engineering-guide` 是 MIT 仓库但 `/data/*.json` 明文声明为 **Suno, Inc. 财产、MIT 不适用**，需 **file 级分档**；`bingnin80-yy/awesome-topmediai-ai-music-prompts` 明文禁止再发布，**不得收录**。
- 不使用 PromptBase / FlowGPT：Cloudflare 拦截且 robots 明确禁止爬虫 UA，同时属付费 marketplace，内容有版权与分成条款，不可作为可再分发语料。

### 6. 许可证分层与版权

- **默认按 GitHub API 返回的 `license.spdx_id` 分流，但允许按仓库声明覆盖**。**判定以实际 LICENSE 文件为准，`spdx_id` 只是默认值。**
  - **覆盖粒度 = 仓库级 + 文件级**（覆盖记录含 `spdxId` 与 `appliesTo` 路径列表）。
    - 理由（实测）：`f/prompts.chat` 是**一仓两许可**（prompt 内容 CC0-1.0、源码 MIT），只有文件级才能表达；`dawgshart/suno-prompt-engineering-guide` 是 MIT 仓库但 `/data/*.json` 明文声明为 Suno 私有数据，MIT 不适用，只有文件级才能把它挡在正文之外。
  - 理由（实测）：`f/prompts.chat` 与 `YouMind-OpenLab/awesome-seedance-2-prompts` 的 `spdx_id` 都是 `NOASSERTION`，但它们的 LICENSE 文件实际分别是 **CC0-1.0** 与 **CC BY 4.0**。只看 `spdx_id` 会让 3000+ 条本可再分发的正文被数据库触发器清空。
  - **FULL 档**（CC0 / MIT / Apache-2.0 等允许再分发的许可证）：存正文，可生成中文简介，可全文检索。
  - **METADATA_ONLY 档**（无许可证或其他限制性许可证）：只存元数据、链接与自行撰写的一句话描述，**不复制原文**，不生成基于原文的简介。
- **CC BY 4.0 内容归 FULL 档，但页面必须署名**（作者 + 许可证标识 + 原仓库链接），否则不得收录。
  - 署名落在 `PromptDetail.attribution` 字段（**与 `contributor` 分开**：`contributor` 是「贡献者署名」，承载不了「作者 + 许可证标识 + 原仓库链接」三合一的要求）。
- 任何 LLM 生成的简介，页面必须标注"**AI 生成，版权归原作者**"，并保留原仓库链接与许可证标识。
- 分层判定为纯函数，有独立单元测试。

### 7. 中文简介生成

- 输入：`SKILL.md` 原文 / MCP 工具定义；输出结构化的 `whenToUse`、`howToUse`、以及分类标签建议。
- 生成结果**以初稿形式存库**（`summarySource=LLM`），用户或运营可覆盖（`summarySource=HUMAN`，记录覆盖时间）。
- **按内容 hash 缓存**，避免重复生成；模型或提示词变更时可批量重跑。
- 失败不阻断入库：降级为模板抽取的描述，并标记来源。

### 8. 检索层

- 定义 `SearchService` 接口作为唯一检索入口，实现与调用方解耦，后期可整体替换为向量检索而不改动调用方。
- 一期实现：Postgres 全文检索 + `pg_trgm` 模糊匹配 + 标签矩阵过滤，三者加权融合。
- 不引入 pgvector / Redis / 外部 rerank 服务（依赖与凭据成本高于当期收益）。
- 触发向量检索的时机：出现"基于已安装资产推荐相关资产"这类语义推荐需求时。

### 9. 前端

- 三个库共用一套页面骨架：列表页（筛选 + 排序 + 分页）、详情页、搜索页。
- 详情页固定包含：中文简介（何时用 / 怎么用）、一键复制按钮组、热度与版本信息、许可证与来源链接、原始内容查看。
- 一键复制覆盖：安装命令、整份 `SKILL.md`、`mcpServers` 配置片段、Prompt 原文。
- 社区内容以"场景卡片"呈现，从已收录资产的 `whenToUse` 与 frontmatter 派生，不做独立编辑后台。

### 10. 账号与互动

- **游客态优先**：浏览、搜索、一键复制、本地收藏、点赞均无需注册。注册墙只出现在两处真正有价值的节点：**发布自己的资产**与**跨设备同步安装清单**。
- 点赞与收藏在游客态下以设备指纹 + IP 限流实现；登录后自动合并到账号。
- 评论必须登录（邮箱验证），以保证责任归属。
- 认证方式：邮箱魔法链接为主，GitHub OAuth 为辅（面向目标用户）。密码哈希沿用 argon2，令牌用 JWT。

### 11. 社区内容与审核

- 发布门槛：邮箱验证通过即可发帖。
- 审核链路：关键词过滤（自动） → 用户举报（其他用户可举报） → 人工抽查（运营者不定期巡查，非全量预审）。
- 不采用"所有新帖先进待审队列"模式：单人运营下会立即成为瓶颈。
- 资产发布同样采用"先自动过滤 + 举报 + 抽查"而非全量预审。

### 12. 场景卡片（一期社区冷启动）

- 从已收录资产的 `whenToUse` 与 frontmatter 自动派生"使用场景卡片"，形式如"想批量处理 PDF 就用这个"。
- 零额外采集成本，且场景卡片本身是搜索入口之一（可被搜索命中并直达技能详情）。
- 卡片内容可由社区补充参数与经验，形成"社区 = 卡片评论区"的结构。

### 13. 二期：版本、依赖与冲突检测

- 版本来源统一为 `AssetVersion`：上游仓库用 commit sha，用户发布的用平台 semver。
- 一键更新 = 对比 `lastSyncedAt` 与上游最新 commit，生成变更日志。
- 依赖声明：由发布者在仓库中提供清单（平台约定的 manifest），平台解析后落入 `AssetDependency`。
- **冲突检测只做查表比对，不做依赖解析器**：扫描候选 MCP server 声明的环境变量名与端口，与用户已安装集合求交集并报告冲突。这是"市场区别于目录"的可见价值点。

### 14. 后续阶段：AI 资讯

- 国际源走 RSS：OpenAI、Google DeepMind、Microsoft Research（字段最全，含 `dc:creator` 与 `content:encoded`）、NVIDIA、Google Research、HF blog、IT之家。
- **Anthropic 无官方 RSS 或 API**（实测多个 feed 与 JSON 路径均 404）：改用官方 `sitemap.xml` 枚举文章 + 解析页面，或使用第三方 RSS 镜像兜底。
- **国内源无 RSS 且多为无路由 SPA 空壳**（智谱、字节 Seed 的 HTML 内无任何 JSON 数据键）：DeepSeek 走静态页 + sitemap（日期从正文解析），Kimi 走 SSR 解析，智谱与豆包需专门处理或放弃。
- 部分主流源**无作者字段**（OpenAI、Anthropic、DeepMind）；署名源以 Microsoft Research 与 NVIDIA 为主。
- 混合信息流：默认全量流（可订阅、可筛选）+ AI 精选流（LLM 打分排序 + 摘要）。
- 复用 `DL-monitor` 的源适配器与质量阈值（GitHub 最低 star 数、HF 最低下载量等），但按新仓库重写，不 fork。

### 15. 里程碑

| 里程碑 | 周期 | 产出 | 验收标准 |
| --- | --- | --- | --- |
| M1 地基 | 1–3 周 | Docker Compose、Prisma schema、采集器框架、GitHub 回源、许可证分层 | 500 条真实 Skill 入库，frontmatter 与许可证分层正确 |
| M2 生成 + 检索 + 前端 | 4–6 周 | DeepSeek 简介生成、`SearchService` 与 PG 实现、三个页面 | 可搜到"批量处理 PDF"并复制出可在 Claude Code 使用的安装命令 |
| M3 互动 + 登录 + 发布 | 7–9 周 | 游客态收藏点赞、邮箱验证登录、评论、过滤与举报、用户发布资产 | 陌生用户可完成“搜 → 复制 → 安装 → 回来评论 → 发布自己的 Skill”完整闭环 |
| M4 另两库 | 10–12 周 | MCP 库（含冲突检测）、Prompt 库（模态分类） | 三库统一搜索可用，MCP 安装前可看到冲突提示 |
| M5 二期 | 13–15 周 | 版本管理、一键更新、变更日志、依赖声明 | 可发布自己的 Skill 并收到版本更新提示 |

> AI 资讯模块与社区独立形态排在 15 周之后，不在前述排期内。

## Testing Decisions

### 什么算好测试

只测**外部可观察行为**，不测实现细节。断言的是"给定输入，产出的规范化条目长什么样"以及"给定数据库状态，HTTP 响应是什么"，而不是"内部调用了哪个函数"。

### 两个 seam

**Seam 1 —— 采集边界（主 seam）**
采集适配器契约是最高层的 seam：输入源配置，输出规范化条目数组。所有源解析的怪癖都在这里被测。

- 用**录制的 fixture**（保存的 API 响应与 HTML 快照）驱动测试，不打真实网络。
- 为每个源建立代表性 fixture，至少覆盖：正常条目、字段缺失、限流响应、空结果、结构变更（用来验证解析器失败时是显式报错而非静默返回空）。
- 断言输出的字段级正确性与去重行为。

**Seam 2 —— HTTP 边界**
Next.js 路由处理器，对着**真实的测试用 Postgres** 测试（不使用内存替身，因为全文检索与 trigram 行为需要在真实 Postgres 上验证）。

- 覆盖：搜索返回预期条目与排序、详情页返回安装命令与配置片段、收藏与点赞计数、评论需登录、举报落库、发布审核状态流转。
- 这一个 seam 顺带覆盖存储、检索、简介生成流水线、互动与账号。

### 一个 port

**LLM 生成接口**作为端口：测试中注入确定性假实现，断言流水线存下了它返回的内容并正确标记 `summarySource`；另有一条默认跳过的契约测试打真实 DeepSeek API，验证响应结构与降级路径。

### 纯函数单元测试（不构成 seam）

- 许可证分层判定：SPDX id → 内容档位。
- 冲突检测：环境变量名与端口集合求交集。
- 热度加权计算。

### 先例

项目内暂无既有测试代码可参照；`dl-resume` 使用 vitest + Playwright，`delong-hot-monitor` 使用无测试基建。**因此采用 vitest 作为单元/集成测试运行器**（与 Next.js、Prisma 同生态），并从 M1 起建立 CI（GitHub Actions）跑 lint + typecheck + test——现有五个相关仓库均无 CI，这是应当补上的基础。

## Out of Scope

- **在线试跑 / 沙箱执行**：不做。需要真实隔离（容器、文件系统、密钥托管、网络策略），单人投入产出比过低，且用户的替代路径是本地安装——配置复制到本机后本就在本地执行。
- **评分与分成机制**：不做。
- **依赖解析与自动求解**：只做查表式冲突检测，不做版本求解或自动改写依赖。
- **移动端 App、小程序**：不做，Web 响应式即可。
- **AI 资讯模块**：后置到独立阶段，不在前 15 周内。
- **向量检索 / pgvector / Redis / 外部 rerank**：一期不用，`SearchService` 接口为其预留替换位。
- **PulseMCP 数据源**：放弃。
- **PromptBase / FlowGPT 内容**：不做爬取；如未来需要，走商务授权。
- **多语言界面**：一期仅中文；不做 i18n 框架。

## Further Notes

### 关键风险

1. **GitHub API 限流** —— 未认证 60 次/小时、认证 5000 次/小时，2 万条采集必须使用独立凭据（建议注册 GitHub App 获取更高配额与更细粒度的权限）并分批 + 强缓存。
2. **skills.sh 榜单结构易变** —— 解析器脆弱；兜底是 sitemap 全量 + GitHub stars 作为次级热度指标。
3. **DeepSeek 批量生成成本** —— 500 条量级为个位数人民币级别；靠内容 hash 缓存防重复生成。
4. **单人风险** —— 关键路径是"采集器 + 简介生成流水线"，前端页面是最该压缩的部分。
5. **合规风险** —— 许可证分层必须在写入路径上强制执行，不能靠人工判断；建议在 CI 中加入密钥扫描与许可证校验。

### 已验证的环境事实

- 本机可用凭据：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`；**其余模型与云服务凭据均未配置**（OpenRouter / DashScope / Anthropic / 智谱 / Kimi 等）。因此不走依赖 OpenRouter 或 DashScope 的既有实现。
- 工具链：Node 24.11、Python 3.11 / 3.13、pnpm 10.21、Docker 28.5.1、git 2.51.2 齐备；`gh` CLI 2.103.3 已安装（未在 PATH 上，需用完整路径）。
- `gh` 已认证为 `TOKEN-DL`，scope 含 `repo`。
- 可复用资产：`DL-monitor`（9 个 AI 圈源适配器、每源独立 cron、质量阈值、3-tier 保留）、`delong-hot-monitor`（RSS/HTML 适配器、LLM 降级封装、通知消毒）、`dl-resume`（三阶段 Dockerfile、docker-compose、Prisma 单例、JWT + argon2 + AES-GCM 工具链）、`agent-skills-zh`（12 种宿主的 Skill 安装指南）。
- 域术语可取自 `TOKEN-DL/Note` 仓库的 `AI智能体开发/` 目录（LLM 调用、提示词工程、function calling、MCP、Agent Skill、RAG、LangGraph 等 9 篇），作为 `GLOSSARY.md` 与 ADR 的素材。

### 已知的数据源事实

- skills.sh 官方 v1 API 存在但需 Vercel OIDC Federation 认证，无 token 时全端点 401；其 robots.txt 禁止 `/api/`。首页与 sitemap 可正常抓取。
- 官方 MCP registry 的 `/v0/servers` 免鉴权可用，但**不提供任何热度指标**。
- PulseMCP 全站对默认 UA 返回 403，robots 禁止 ClaudeBot / GPTBot / anthropic-ai 等。
- Reddit 的 `.json` 端点全站 403；公共 RSSHub 实例亦 403。
- Anthropic 无官方 RSS/API；智谱与字节 Seed 为纯 CSR 空壳；Qwen 的 GitHub feed 停更于 2025-09。

### 与既有资产的关系

本项目是 `TOKEN-DL/com-ai` 仓库的**首个业务模块**。仓库此前只有工程技能配置（`AGENTS.md` 与 `docs/agents/`），现补充本 spec、随后的票据，以及随 `/domain-modeling` 产出的 `GLOSSARY.md` 与 ADR。
