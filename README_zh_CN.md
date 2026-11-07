# Ype! Writer (`dsh-ype-writer`)

一个 DSH 文章审校器：依据 `rule.toml` 逐段给文章打分。每条规则都开启独立的 LLM 会话，因此评分标准可复现、可审阅、可提交版本库。

- **受众 / 反受众**：两个独立会话分别评估受众契合度与反受众可读性，据此推导出实测的"迎合度指数"，并与目标值比较。
- **每条规则一个会话**：反模式、禁忌项与要求各自在自己的会话中运行；`llm = N` 会运行多个副本并取平均值。
- **脚本规则**：用 Python 函数做确定性检查，不消耗 token。
- **无运行时依赖**：TOML 解析器随包发布，无需向 profile 额外安装任何东西。

## 安装与加载

环境要求：

- 具备插件管理器的 DSH（`plugin_manager` 工具或 Creator 模式）
- Node.js 20 或更高版本
- 仅在用到脚本规则或过滤规则时需要 Python 3

### 通过 DSH CLI

安装到你启动的 profile（把 `web` 换成你的 profile 名）：

```bash
dsh plugin --profile web add github:catilgrass/ype-writer
```

该包会自动加入 `dsh.profile.bundles`。HMR 会把它应用到正在运行的 profile；否则重启 `dsh web`。卸载方式：

```bash
dsh plugin --profile web remove dsh-ype-writer
```

### 通过 DSH Web UI

1. 在侧边栏打开 **Plugins**，点击 **Add plugin**。
2. 输入 `https://github.com/catilgrass/ype-writer`。
3. 点击 **Install**，等待出现 "Installed"。

### 让 Agent 代劳

把下面这段粘贴到能够使用插件管理器的会话（Creator 模式或完全访问权限）：

> 用 `plugin_manager`（`install_bundle`）把来自 https://github.com/catilgrass/ype-writer 的 DSH bundle 安装到当前 profile，然后确认工具列表中出现了 `ype_check`、技能目录中出现了 `ype-writer`。最后做一次冒烟检查：`ype_check(template: "tutorial-guide", text: "This is a smoke test.")`

加载器会热加载该 bundle，因此使用该 profile 的每个会话都会出现 `ype_check`；如果 profile 配有技能目录，`ype-writer` 技能也会加入其中。想从本地检出安装？改用 `target` 传入绝对路径，并在每次修改后重新安装。

## 使用

```text
ype_check(rule: "examples/rule.toml", path: "examples/article.md")
```

| 参数       | 必填条件             | 含义                                                        |
| ---------- | -------------------- | ----------------------------------------------------------- |
| `rule`     | rule/template 二选一 | 规则文件路径，可使用绝对路径或相对于会话工作目录的相对路径  |
| `template` | rule/template 二选一 | 内置模板名，例如 `health-science` 或 `zh_CN/health-science` |
| `text`     | text/path 二选一     | 完整的文章文本                                              |
| `path`     | text/path 二选一     | 文章文件路径                                                |

工具返回一份 Markdown 报告（`value.report`），以及可供程序使用的分段、分规则结构化结果。报告中保留了每条规则的原始分数，因此最终得分可以重新计算。

拿这份 README 试试：

```text
ype_check(rule: "readme-review.toml", path: "README.md")
```

### 临时规则

如果 `rule` 指向的不是合法 TOML——Markdown 审稿规范、写坏的规则、损坏的文件——工具会把它转成一份合法规则：文件里写明的审查要求（哪怕是散文或 Markdown）会被保留，损坏的 TOML 会被修复，剩下的从文章推断。检查随即用这份规则运行，并在报告的 "Temporary rule" 下列出它，同时追加一条警告说明规则是生成还是修复的。草稿不会写入磁盘。这会多花一次模型调用（最多两次，第一次校验失败时），适用于不方便在仓库里保留规则文件的一次性审校。可在插件配置里用 `autoDraftRules: false` 关闭。

## 过滤器

过滤器把审校范围收窄到真正需要关注的文本。每个过滤器都是一个定义 `filter(text)` 的 Python 脚本，只返回需要检查的文本；返回的字符串会被一次性切分成段落，并供所有会话共享。只审评论、剥离 Markdown 等场景都使用同一套约定。

```toml
[[filters]]
name = "comments only"
code = '''
def filter(text):
    return "\n\n".join(line.strip() for line in text.splitlines() if line.strip().startswith("//"))
'''
```

`filters/` 内置三个选取脚本：`comments.py`（只取 `//` 开头的行）、`markdown.py`（只取正文、去掉 Markdown 脚手架；围栏标记丢弃、内容保留）和 `code.py`（只取围栏代码块）。按路径引用其中一个，路径相对于规则文件：

```toml
[[filters]]
path = "filters/markdown.py"
```

过滤器按声明顺序执行。如果整条过滤链什么都没选中，检查会直接失败，而不是悄悄给一篇文章打空分；报告中会列出执行了哪些过滤器以及各自删掉了多少字符。

## 技能与模板

加载时，插件会向 profile 的技能注册表注册一个 `ype-writer` 技能（没有技能服务的 profile 则只获得该工具）。该技能记录了推荐的工作流：**写文章 → 把模板复制为 `rule.toml` → 改造它 → 运行 `ype_check` → 根据报告迭代**，此外还包括规则设计指南、如何阅读报告以及常见错误。

`templates/` 内置八份可直接复制的规则模板：

| 模板                     | 适用场景                    | 主要护栏                               |
| ------------------------ | --------------------------- | -------------------------------------- |
| `health-science.toml`    | 面向患者及家属的健康科普    | 治愈宣传、制造恐惧、替代用药、伪科学   |
| `science-explainer.toml` | 面向普通读者的科学解读      | 把相关当因果、夸大炒作、未解释的术语   |
| `product-review.toml`    | 消费者产品评测              | 未披露的利益关系、虚假实测、单方面吹捧 |
| `tutorial-guide.toml`    | 环境搭建与分步指南          | 跳步、无法运行的命令、缺失版本号       |
| `opinion-piece.toml`     | 社论与议论文                | 稻草人论证、人身攻击、事实与判断混淆   |
| `news-report.toml`       | 事件报道与访谈              | 未核实的事实、标题党、单一信源         |
| `code-review.toml`       | Pull Request 与代码片段审查 | 硬编码密钥、被吞掉的错误、信息泄漏     |
| `write-documents.toml`   | 项目文档与用户可见文案      | 营销式夸张、先否定再肯定、空话         |

中文版放在 `templates/zh_CN/` 下，文件名相同；测试会保持两套模板同步。技能加载时，已安装的模板目录的绝对路径会追加到其指令中，因此 Agent 无需猜测包的位置就能读取模板。

## rule.toml 参考

完整示例见 [`examples/rule.toml`](examples/rule.toml)。

```toml
[target]
audience = "backend engineers with 3-5 years of experience who know SQL but not query optimizers"
anti_audience = "product managers with no database experience"  # inferred by the LLM when omitted
pandering = 3                                                   # target pandering 1-5, default 3
audience_llm = 1                                                # audience sessions, default 1
anti_audience_llm = 1                                           # anti-audience sessions, default 1

[[anti_patterns]]                # a hit zeroes that paragraph
name = "Disclaimer"
description = 'paragraph contains "for reference only" or "not advice"'
llm = 1

[[donts]]                        # violation scored 1-5
name = "Empty adjectives"
instruction = 'uses "ultimate", "perfect", or "revolutionary" without information'
scope = "paragraph"              # paragraph (default) | article
llm = 2                          # two independent sessions, averaged

[[requirements]]                 # compliance scored 1-5
name = "Actionable conclusion"
instruction = "the article ends with an executable conclusion"
scope = "article"

[[scripts]]                      # deterministic script rule
name = "First person"
path = "scripts/no_first_person.py"   # relative to rule.toml; or inline code = "..."
```

字段约束：

| 字段                                         | 约束                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `audience`                                   | 非空字符串，或非空的字符串数组（用 `; ` 连接）                       |
| `anti_audience`                              | 同上；省略或为空表示由 LLM 推断                                      |
| `pandering`                                  | 1 到 5 之间的数字                                                    |
| `audience_llm` / `anti_audience_llm` / `llm` | 1 到 8 之间的整数                                                    |
| `scope`                                      | `paragraph`（默认）或 `article`；脚本规则只接受 `paragraph`          |
| `[[scripts]]`                                | `path` / `code` 二选一；给出的 `path` 必须存在                       |
| `[[filters]]`                                | `path` / `code` 二选一；脚本需定义 `filter(text)` 并返回待检查的文本 |

未知字段、类型错误和 TOML 语法错误会在任何模型调用之前失败，并给出文件名与行列位置。上限：每类规则 20 条，脚本 10 个。

## 评分

### 迎合度指数

每个段落会分别从受众会话和反受众会话各获得一个 1-5 的整数：

- `audienceFit`：该段落对目标受众的契合程度（越高越契合）
- `antiAudienceFit`：反受众仍能读懂该段落的地步（越高越易读）

```text
pandering index m = 1 + 4 × audienceFit / (audienceFit + antiAudienceFit)
closeness     c = clamp(5 - 2 × |m - target|, 0, 5)
```

`m = 3` 表示两类读者都看得懂；`m → 5` 表示只有目标受众看得懂（圈内术语、信息密度高）；`m → 1` 表示只有反受众看得懂。越接近目标值，closeness 越高。

### 规则分与段落分

每条规则（反模式、禁忌项、要求、脚本）先产生一个平均后的原始分：

- 一条规则有 N 个 LLM 会话时，各会话独立打分，副本分数**按段落取平均**；
- 反模式是布尔判定，因此 N 个会话采用**多数票**（必须严格超过半数一致）；
- 脚本规则对每个段落返回 0-5 的违规分。

质量分换算：禁忌项/脚本质量 = `6 - violation`（0 次违规得 5 分），要求质量 = 符合度，反模式命中记 0 分、未命中记 5 分。

```text
paragraph score = anti-pattern hit ? 0
                : weighted mean(closeness × 3, each rule's quality × 1)
overall score   = weighted mean(paragraph mean × 3, each article rule's quality × 1)
```

规则不适用的段落会由会话省略，视为"未参与"。某个会话失败只会追加一条警告并降低该规则的置信度，而不会让检查失败；只有当所有会话都失败时检查才会失败。

## 脚本规则

脚本是一个定义 `check(text)` 的 Python 文件：

```python
def check(text: str):
    return 0     # violation 0-5; 0 means no violation
    # return None  # this paragraph does not participate
```

每个脚本会启动一个 Python 进程，并对每个段落调用一次 `check`。脚本的 stdout 会重定向到 stderr，以免污染结果；越界取值、异常和超时都会转成警告。解释器由 `config.python` 配置（默认 `python3`）。

## 插件配置

`config` 是可选的；未知字段会导致激活失败，这样拼写错误不会被静默忽略。

| 字段                 | 默认值       | 含义                                         |
| -------------------- | ------------ | -------------------------------------------- |
| `provider` / `model` | 当前会话模型 | 覆盖评分会话使用的路由（必须同时设置）       |
| `reasoningEffort`    | 会话取值     | 覆盖推理强度                                 |
| `maxParagraphs`      | `80`         | 最多评分的段落数；其余会被截断并给出警告     |
| `maxParagraphChars`  | `2000`       | 每个段落的最大字符数；超出的会被裁剪         |
| `maxConcurrentLlm`   | `6`          | 最大并发模型会话数                           |
| `llmTimeoutMs`       | `180000`     | 单个模型会话的超时时间                       |
| `maxOutputTokens`    | `12000`      | 单个模型会话的输出上限                       |
| `python`             | `python3`    | 脚本规则使用的解释器                         |
| `autoDraftRules`     | `true`       | 规则文件无法解析为 TOML 时，临时起草一份规则 |
| `scriptTimeoutMs`    | `20000`      | 单个脚本的超时时间                           |

## 成本

每次检查的模型调用数：

```text
1 (anti-audience inference, when anti_audience is omitted)
+ audience_llm
+ anti_audience_llm
+ Σ each rule's llm
```

每个会话都会收到整篇文章，因此 token 成本大致为文章 token 数 × 会话数。按默认配置（1 个受众会话、1 个反受众会话，若干条规则各 1 次）一次检查约为 4-8 个会话。先从每条规则一个会话起步；只对真正重要的规则增加副本。当规则文件无法解析且 `autoDraftRules` 开启时，再加一次起草调用（最多两次）。

## 实现与维护

- **零依赖**：只使用 Node 内置模块和本仓库内的文件。`lib/toml.js` 是一个 TOML 子集解析器，支持表、表数组、点号键、多行字符串、内联表、数字和日期（以源文本返回）。
- **只用公开 API**：通过 `ctx.tools.register` 注册，通过 `ctx.llm.stream` 调用模型，从不写会话日志或触碰私有状态。
- **可测试**：`lib/` 按职责拆分（TOML → 规则校验 → 评分数学 → 模型调用 → Python → 引擎 → 工具入口）。47 个 `node --test` 用例在无网络的情况下覆盖解析、校验、公式、聚合与容错。
- **无 UI**：结果是文本报告。也可以在同一 bundle 中加一个 Client 模块作为浏览器面板，把 `value.paragraphs` / `value.rules` 渲染成表格。

已知限制：

- 分数依赖 LLM，所以同一篇文章两次检查结果可能不同；`llm = N` 只能降低方差。
- 反模式采用多数票，规则越模糊，会话之间越容易分歧。
- 长文章会被 `maxParagraphs` / `maxParagraphChars` 截断，报告会标注这一点。
- 提示词是英文的；对非英文文章通常仍可用，但没有做任何语言适配。
- 脚本规则需要本地 Python；没有它时只有脚本规则失败，其余检查照常运行。
