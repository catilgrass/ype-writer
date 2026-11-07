# Rule templates

Templates are starting points, not finished rules. Copy one next to the article, rename it `rule.toml`, then edit `[target]` and the rules. The audience profiles are placeholders: running a template unchanged measures the template, not your article.

| Template | Use for | Main guardrails |
| --- | --- | --- |
| `health-science.toml` | Patient and family health explainers | cure claims, fear, replacing medication, pseudoscience |
| `science-explainer.toml` | Science for general readers | correlation as causation, hype, unexplained jargon |
| `product-review.toml` | Consumer product reviews | undisclosed interests, fake testing, one-sided praise |
| `tutorial-guide.toml` | Setup and step-by-step guides | skipped steps, unrunnable commands, missing versions |
| `opinion-piece.toml` | Editorials and argument essays | straw men, personal attacks, fact/judgment blur |
| `news-report.toml` | Event reporting and interviews | unverified facts, clickbait, single sources |

Chinese copies live under `zh_CN/` with the same file names. The English and Chinese sets are validated to stay in sync.

## Use

```text
ype_check(rule: "rule.toml", path: "final.md")
```

Every LLM rule opens its own scoring session; templates default to `llm = 1` per rule. Add replicas (`llm = 2`) only after a rule proves it separates good text from bad.

## What to edit first

1. `[target]`: the audience and anti-audience drive the pandering index and how the sessions read the article.
2. Remove rules: fewer rules score more accurately; delete anything this article cannot violate.
3. Adjust script thresholds: paragraph length and word limits depend on where the piece will be read, and mobile readers tolerate less.
