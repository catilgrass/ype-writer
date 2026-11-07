# Write once, read many: a short piece on query indexes
# Example article used by examples/rule.toml.

Indexes are never free: every extra index makes writes slower, and most teams add them without measuring the read they are supposed to speed up.

A good index answers one specific query shape. If you cannot name the query, the index is a guess dressed up as an optimization.

Start with the slowest query, read its plan, and add only the index that plan asks for. Then measure again: a write-heavy table may get slower in exchange for a read that was already fast enough.

This analysis is for reference only and is not a change recommendation.
