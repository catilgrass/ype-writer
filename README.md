# Ype! Writer (`dsh-ype-writer`)

> 本提供了 [中文版本](./README_zh_CN.md)！

A DSH article auditor that scores an article paragraph by paragraph against a `rule.toml`. Every rule opens its own LLM session, so the scoring standard is reproducible, reviewable, and committable.

- **Audience / anti-audience**: two independent sessions score audience fit and anti-audience legibility, from which a measured "pandering index" is derived and compared with the target.
- **One session per rule**: anti-patterns, don'ts, and requirements each run in their own session; `llm = N` runs replicas and averages them.
- **Script rules**: Python functions for deterministic checks; no tokens spent.
- **No runtime dependencies**: the TOML parser ships with the package; nothing extra to install into a profile.

## Install and load

Requirements:

- DSH with the plugin manager available (the `plugin_manager` tool or Creator mode)
- Node.js 20 or newer
- Python 3 only if you use script or filter rules

### From the DSH CLI

Install into the profile you boot (replace `web` with your profile name):

```bash
dsh plugin --profile web add github:catilgrass/ype-writer
```

The package is added to `dsh.profile.bundles` automatically. HMR applies it to the running profile; otherwise restart `dsh web`. Remove it with:

```bash
dsh plugin --profile web remove dsh-ype-writer
```

### From the DSH web UI

1. Open **Plugins** in the sidebar and click **Add plugin**.
2. Enter `https://github.com/catilgrass/ype-writer`.
3. Click **Install** and wait for "Installed".

### Ask an agent

Paste this into a session that can use the plugin manager (Creator mode, or full access):

> Install the DSH bundle from https://github.com/catilgrass/ype-writer into this profile with `plugin_manager` (`install_bundle`), then confirm `ype_check` appears in the tool list and `ype-writer` in the skill catalog. Finish with a smoke check: `ype_check(template: "tutorial-guide", text: "This is a smoke test.")`

The loader hot-loads the bundle, so `ype_check` appears in every session using that profile, and the `ype-writer` skill joins the skill catalog when the profile has one. Working from a local checkout? Use `target` with the absolute path instead, and reinstall after edits.

## Use

```text
ype_check(rule: "examples/rule.toml", path: "examples/article.md")
```

| Argument   | Required             | Meaning                                                                      |
| ---------- | -------------------- | ---------------------------------------------------------------------------- |
| `rule`     | one of rule/template | Path to the rule file, absolute or relative to the session working directory |
| `template` | one of rule/template | Bundled template name such as `health-science` or `zh_CN/health-science`     |
| `text`     | one of text/path     | Full article text                                                            |
| `path`     | one of text/path     | Path to the article file                                                     |

The tool returns a Markdown report (`value.report`) plus structured per-paragraph and per-rule results for programmatic use. The report keeps every rule's raw score so the final score can be recomputed.

Try it on this README:

```text
ype_check(rule: "readme-review.toml", path: "README.md")
```

## Filters

Filters narrow the review to the copy that matters. Each filter is a Python script defining `filter(text)` that returns only the text to check; the returned string is split into paragraphs once and shared by every session. Comment-only reviews and Markdown stripping use the same contract.

```toml
[[filters]]
name = "comments only"
code = '''
def filter(text):
    return "\n\n".join(line.strip() for line in text.splitlines() if line.strip().startswith("//"))
'''
```

Three selection scripts ship in `filters/`: `comments.py` (only `//` lines), `markdown.py` (prose without Markdown scaffolding; fence markers dropped, contents kept), and `code.py` (only fenced code). Reference one by path, relative to the rule file:

```toml
[[filters]]
path = "filters/markdown.py"
```

Filters run in declared order. A chain that selects nothing fails the check instead of silently scoring an empty article, and the report lists which filters ran and how many characters they removed.

## Skill and templates

On load, the plugin registers a `ype-writer` skill with the profile's skill registry (profiles without a skills service simply get the tool). The skill documents the recommended workflow: **write the article → copy a template into `rule.toml` → adapt it → run `ype_check` → iterate on the report**, plus rule design guidance, how to read the report, and common mistakes.

`templates/` ships seven copy-ready rule templates:

| Template                 | Use for                              | Main guardrails                                        |
| ------------------------ | ------------------------------------ | ------------------------------------------------------ |
| `health-science.toml`    | Patient and family health explainers | cure claims, fear, replacing medication, pseudoscience |
| `science-explainer.toml` | Science for general readers          | correlation as causation, hype, unexplained jargon     |
| `product-review.toml`    | Consumer product reviews             | undisclosed interests, fake testing, one-sided praise  |
| `tutorial-guide.toml`    | Setup and step-by-step guides        | skipped steps, unrunnable commands, missing versions   |
| `opinion-piece.toml`     | Editorials and argument essays       | straw men, personal attacks, fact/judgment blur        |
| `news-report.toml`       | Event reporting and interviews       | unverified facts, clickbait, single sources            |
| `code-review.toml`       | Pull-request and snippet reviews     | hard-coded secrets, swallowed errors, leaks            |

Chinese copies live in `templates/zh_CN/` under the same file names; tests keep the two sets in sync. When the skill loads, the absolute path of the installed template directory is appended to its instructions, so an agent can read the templates without guessing where the package lives.

## rule.toml reference

See [`examples/rule.toml`](examples/rule.toml) for a complete example.

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

Field constraints:

| Field                                        | Constraint                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `audience`                                   | Non-empty string, or a non-empty string array (joined with `; `)                                |
| `anti_audience`                              | Same; omitted or empty means the LLM infers it                                                  |
| `pandering`                                  | Number from 1 to 5                                                                              |
| `audience_llm` / `anti_audience_llm` / `llm` | Integer from 1 to 8                                                                             |
| `scope`                                      | `paragraph` (default) or `article`; scripts only accept `paragraph`                             |
| `[[scripts]]`                                | Exactly one of `path` / `code`; a supplied `path` must exist                                    |
| `[[filters]]`                                | Exactly one of `path` / `code`; the script defines `filter(text)` and returns the text to check |

Unknown fields, wrong types, and TOML syntax errors fail before any model call, with the file name and line/column. Limits: 20 rules per kind, 10 scripts.

## Scoring

### Pandering index

Each paragraph receives a 1-5 integer from the audience session and another from the anti-audience session:

- `audienceFit`: how well the paragraph serves the target audience (higher is better fit)
- `antiAudienceFit`: how easily the anti-audience still follows the paragraph (higher is more legible to them)

```text
pandering index m = 1 + 4 × audienceFit / (audienceFit + antiAudienceFit)
closeness     c = clamp(5 - 2 × |m - target|, 0, 5)
```

`m = 3` means both groups understand; `m → 5` means only the audience does (in-group jargon, high density); `m → 1` means only the anti-audience does. The closer to the target, the higher the closeness.

### Rule and paragraph scores

Every rule (anti-pattern, don't, requirement, script) first produces an averaged raw score:

- with N LLM sessions for one rule, each session scores independently and replicas are **averaged per paragraph**;
- anti-patterns are boolean, so N sessions use a **majority vote** (strictly more than half must agree);
- script rules return a 0-5 violation per paragraph.

Quality conversion: don't/script quality = `6 - violation` (0 violations score 5), requirement quality = compliance, anti-pattern hit scores 0 and a miss scores 5.

```text
paragraph score = anti-pattern hit ? 0
                : weighted mean(closeness × 3, each rule's quality × 1)
overall score   = weighted mean(paragraph mean × 3, each article rule's quality × 1)
```

Paragraphs a rule does not apply to are omitted by the session and count as "not participating". A failed session adds a warning and lowers that rule's confidence instead of failing the check; the check only fails when every session fails.

## Script rules

A script is a Python file defining `check(text)`:

```python
def check(text: str):
    return 0     # violation 0-5; 0 means no violation
    # return None  # this paragraph does not participate
```

One Python process is started per script and `check` is called once per paragraph. Script stdout is redirected to stderr so it cannot pollute the result; out-of-range values, exceptions, and timeouts become warnings. The interpreter is configured with `config.python` (default `python3`).

## Plugin config

`config` is optional; unknown fields fail activation so typos cannot be silently ignored.

| Field                | Default               | Meaning                                                            |
| -------------------- | --------------------- | ------------------------------------------------------------------ |
| `provider` / `model` | current session model | Override the route used by scoring sessions (must be set together) |
| `reasoningEffort`    | session value         | Override reasoning effort                                          |
| `maxParagraphs`      | `80`                  | Maximum paragraphs scored; the rest are truncated with a warning   |
| `maxParagraphChars`  | `2000`                | Maximum characters per paragraph; longer ones are clipped          |
| `maxConcurrentLlm`   | `6`                   | Maximum concurrent model sessions                                  |
| `llmTimeoutMs`       | `180000`              | Timeout for one model session                                      |
| `maxOutputTokens`    | `12000`               | Output limit for one model session                                 |
| `python`             | `python3`             | Interpreter for script rules                                       |
| `scriptTimeoutMs`    | `20000`               | Timeout for one script                                             |

## Cost

Model calls per check:

```text
1 (anti-audience inference, when anti_audience is omitted)
+ audience_llm
+ anti_audience_llm
+ Σ each rule's llm
```

Every session receives the whole article, so token cost is roughly article tokens × session count. With defaults (1 audience, 1 anti-audience, a few rules at 1 each) a check is about 4-8 sessions. Start with one session per rule; add replicas only for rules that matter.

## Implementation and maintenance

- **Zero dependencies**: only Node built-ins and files in this repository. `lib/toml.js` is a TOML subset parser covering tables, arrays of tables, dotted keys, multi-line strings, inline tables, numbers, and dates (returned as source text).
- **Public APIs only**: registers through `ctx.tools.register`, calls models through `ctx.llm.stream`, never writes session logs or touches private state.
- **Testable**: `lib/` is split by responsibility (TOML → rule validation → scoring math → model calls → Python → engine → tool entry). 38 `node --test` cases cover parsing, validation, formulas, aggregation, and failure tolerance without network access.
- **No UI**: the result is a text report. A browser panel could be added as a Client module in the same bundle, rendering `value.paragraphs` / `value.rules` as a table.

Known limitations:

- Scores depend on an LLM, so two checks of the same article can differ; `llm = N` only reduces variance.
- Anti-patterns use a majority vote; vaguer rules make sessions more likely to disagree.
- Long articles are truncated by `maxParagraphs` / `maxParagraphChars`, and the report marks it.
- Prompts are English; they generally still work on non-English articles, but no language adaptation is done.
- Script rules need a local Python; without it only the script rules fail and the rest of the check still runs.
