# Example script rule: flag first-person narration.
#
# Ype! calls check(text) once per paragraph:
#   - returning 0-5 is the violation score (0 = no violation, 5 = severe);
#   - returning None means the paragraph does not participate.
#
# The script only needs a check function; it may import any library available to
# the interpreter configured in the plugin's `python` setting.

import re

FIRST_PERSON = re.compile(r"\b(?:I|me|my|mine|we|us|our|ours)\b", re.IGNORECASE)


def check(text: str):
    if len(text) < 20:
        return None
    hits = len(FIRST_PERSON.findall(text))
    return min(5, hits) if hits else 0
