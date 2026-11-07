// Filters are selection scripts: each one receives the whole text and returns
// only the regions that deserve review. A comment-only filter, a Markdown
// prose extractor, and a fenced-code extractor are all the same contract.
// Filters are explicit because silently changing the input would silently
// change every score a rule file produces.

import { dirname } from 'node:path';
import { runFilterScript } from './python.js';

// A chain that selects nothing is an error rather than an empty check: an empty
// article would look like a perfect score in the report.
export async function applyFilters({ filters, text, config, signal }) {
  const source = String(text);
  let body = source;
  const applied = [];
  for (const filter of filters) {
    try {
      body = await runFilterScript({
        script: filter,
        text: body,
        python: config.python,
        cwd: filter.path === undefined ? config.ruleBaseDir : dirname(filter.path),
        timeoutMs: config.scriptTimeoutMs,
        signal,
      });
    } catch (error) {
      throw new Error(`filter "${filter.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    applied.push(filter.name);
  }
  if (applied.length > 0 && body.trim().length === 0) {
    throw new Error(`the filter chain (${applied.join(', ')}) selected no text`);
  }
  return { text: body, applied, removedChars: Math.max(0, source.length - body.length) };
}
