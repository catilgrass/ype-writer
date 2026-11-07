# Selection filter: keep only // comment lines.
#
# This is the smallest useful filter: it narrows the review to code comments,
# so copy rules judge the comments and ignore the code around them. The plugin
# calls filter(text) once with the whole document and splits whatever string is
# returned into paragraphs.

def filter(text):
    lines = [line.strip() for line in text.splitlines() if line.strip().startswith("//")]
    return "\n\n".join(lines)
