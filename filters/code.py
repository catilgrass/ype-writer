# Selection filter: keep only fenced code blocks.
#
# Use it when the thing under review is the snippet, not the explanation around
# it. A plain source file with no fences is returned as-is, so a .py or .ts file
# can be reviewed without wrapping it in Markdown first.

import re

FENCE = re.compile(r"^[ \t]{0,3}(?:```|~~~)[^\n]*\n([\s\S]*?)^[ \t]{0,3}(?:```|~~~)[^\n]*$", re.MULTILINE)


def filter(text):
    blocks = [block.strip() for block in FENCE.findall(text)]
    return "\n\n".join(blocks) if blocks else text.strip()
