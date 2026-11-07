# Selection filter: strip Markdown scaffolding and keep the prose.
#
# Headings, horizontal rules, frontmatter, and table pipes are containers, not
# copy; scoring them as paragraphs inflates length checks and lets structure
# outvote writing. Fence markers are removed but their contents stay, because a
# README's install command lives inside a fence and rules must still see it.

import re

FRONTMATTER = re.compile(r"^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)")
COMMENT = re.compile(r"<!--[\s\S]*?-->")
FENCE = re.compile(r"^[ \t]{0,3}(?:```|~~~)[^\n]*\n([\s\S]*?)^[ \t]{0,3}(?:```|~~~)[^\n]*$", re.MULTILINE)
HEADING = re.compile(r"^[ \t]{0,3}#{1,6}(?:\s|$)")
RULE = re.compile(r"^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,}|={3,})[ \t]*$")
REFDEF = re.compile(r"^[ \t]{0,3}\[[^\]]+\]:[ \t]*\S+")
QUOTE = re.compile(r"^[ \t]{0,3}(?:>[ \t]?)+")
LIST = re.compile(r"^[ \t]{0,3}(?:[-+*]|\d{1,3}[.)])[ \t]+")
IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
CODE = re.compile(r"`([^`\n]+)`")
BOLD = re.compile(r"\*\*([^*\n]+)\*\*")
UNDER = re.compile(r"__([^_\n]+)__")
STRIKE = re.compile(r"~~([^~\n]+)~~")
AUTOLINK = re.compile(r"<((?:https?://|mailto:)[^>\s]+)>")


def inline(line):
    line = IMAGE.sub(r"\1", line)
    line = LINK.sub(r"\1", line)
    line = CODE.sub(r"\1", line)
    line = BOLD.sub(r"\1", line)
    line = UNDER.sub(r"\1", line)
    line = STRIKE.sub(r"\1", line)
    line = AUTOLINK.sub(r"\1", line)
    return line


def filter(text):
    body = text.replace("\r\n", "\n").replace("\r", "\n")
    body = FRONTMATTER.sub("", body)
    body = COMMENT.sub("", body)
    body = FENCE.sub(r"\1", body)
    out = []
    for raw in body.split("\n"):
        if HEADING.match(raw) or RULE.match(raw) or REFDEF.match(raw):
            continue
        if "|" in raw and re.match(r"^[ \t]{0,3}\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$", raw):
            continue
        line = QUOTE.sub("", raw)
        line = LIST.sub("", line)
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|") and len(stripped) > 2:
            cells = [cell.strip() for cell in stripped[1:-1].split("|") if cell.strip()]
            line = ", ".join(cells)
        out.append(inline(line))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
