---
name: ype-writer
description: Constrain a written article with a reproducible rule file, then score and iterate with ype_check.
whenToUse: After writing or revising an article (explainer, review, tutorial, opinion, news, marketing copy), or when asked to audit an existing article for audience fit and soft-ad tone.
---

# Ype! Writer

When you write an article, finish with a self-check: encode the mistakes this article must not make in a `rule.toml`, then let `ype_check` score it paragraph by paragraph. Rules make the score meaningful; without them it is just a second opinion.

## When rules are worth it

- The article will be published, submitted, or handed to a client, so the reader is not the author.
- The audience is specific and the failure modes are known: overclaiming results, attacking competitors, jargon walls, a lecturing tone, invented authority.
- Nobody reviews the draft, and "it reads fine" is the only signal.

The closer an article gets to persuading someone, the more a rule file is worth writing. Personal notes and throwaway drafts can skip this.

## Workflow

1. Write the article to a file (for example `final.md`) before scoring it.
2. State three things in one sentence each: who the reader is, what they care about, what this article must never do.
3. Pick the closest bundled template, copy it next to the article as `rule.toml`, and edit `[target]` and the rules.
4. Run `ype_check(rule: "rule.toml", path: "final.md")`.
5. Read the report in this order: anti-patterns, then don'ts and whole-article requirements, then paragraph scores.
6. Both the article and the rules can be wrong. If a low score has a weak reason, fix the rule before touching the text.
7. Rerun until the score and the reasons both make sense.

## rule.toml anatomy

```toml
[target]
audience = "who this is for"          # required; write a person, not a demographic
anti_audience = "who this is not for" # optional; inferred by the LLM when omitted
pandering = 3                         # target pandering 1-5; 3 = both groups understand
audience_llm = 1                      # audience sessions, 1-8

[[anti_patterns]]                     # a hit zeroes that paragraph; use for vetoes
name = "Sells a cure"
description = "claims a product treats disease or replaces medication"

[[donts]]                             # violation scored 1-5 per paragraph
name = "Fear appeal"
instruction = "scares the reader into buying with complication threats"
scope = "paragraph"                   # paragraph (default) or article

[[requirements]]                      # compliance scored 1-5
name = "Cites sources"
instruction = "key claims cite a checkable source"
scope = "article"

[[scripts]]                           # Python check(text), returns 0-5 per paragraph
name = "Paragraph length"
code = '''
import re
def check(text):
    n = len(re.sub(r"\s+", "", text))
    return 0 if n <= 170 else min(5, 1 + (n - 170) // 30)
'''
```

## Rule-writing guidance

- Write an anti-pattern as something a reader can point at, not as a value statement.
- Do not duplicate an anti-pattern as a don't: the former is boolean and zeroes a paragraph, the latter is a 1-5 gradient.
- Keep the total under ten rules. Every LLM rule is an independent session, so cost grows linearly with rule count.
- Start every LLM rule at `llm = 1`; raise replicas only after the rule proves it can separate good text from bad.
- Use `scope = "paragraph"` for "each paragraph should do X" and `scope = "article"` for "the piece as a whole must contain Y".
- Reserve scripts for deterministic checks (length, word count, required or banned terms); semantic judgment belongs to an LLM session.
- Name the exceptions inside a rule ("quoting a scam phrase as an example does not count"). This removes most false positives.

## Reading the report

- Overall score = paragraph mean (weight 3) and whole-article rule quality (weight 1 each), combined.
- Paragraph score = audience closeness (weight 3) and each applicable rule's quality (weight 1 each).
- An anti-pattern hit zeroes the paragraph, so start there.
- Both audiences scoring 5 means the pandering index is 3 and closeness is maximal; text only insiders understand pushes the index up and away from the target.
- A script score of 0 means no violation; "Rules (raw)" keeps the raw violation or compliance value before conversion.

## Common mistakes

- Vague requirements ("make it engaging") produce random scores.
- Demographic audiences ("young people") leave the scoring sessions with nothing to grip.
- Copying a template without editing it measures the template, not your article.
- Running once and shipping: read the reasons and separate article problems from rule problems.
- Using scripts for semantic judgment; scripts only see characters.

## Tool call

```text
ype_check(rule: "rule.toml", path: "final.md")
```

Paths resolve against the session working directory. Pass `text` instead of `path` for short snippets, and pass `template` instead of `rule` to run a bundled template without writing a file.
