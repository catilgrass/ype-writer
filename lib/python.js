// Python bridges for script rules and script filters. The runner is a small
// protocol on stdio: JSON in, JSON out. Keeping one spawn helper means timeouts,
// cancellation, and exit-code handling behave the same for both.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// check(text) runs once per paragraph; the array contract lets the Node side
// reject a length mismatch instead of silently shifting scores onto neighbors.
const CHECK_RUNNER = String.raw`
import contextlib
import importlib.util
import json
import sys

def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("ype_rule", path)
if spec is None or spec.loader is None:
    fail("failed to load the script file")
module = importlib.util.module_from_spec(spec)
try:
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
except Exception as exc:
    fail("script failed to import: %s: %s" % (type(exc).__name__, exc))
fn = getattr(module, "check", None)
if not callable(fn):
    fail("the script must define a callable check(text)")

payload = json.load(sys.stdin)
results = []
for item in payload:
    try:
        with contextlib.redirect_stdout(sys.stderr):
            value = fn(item)
        if value is None:
            results.append(None)
        else:
            number = float(value)
            if number != number:
                results.append({"error": "returned NaN"})
            elif number < 0 or number > 5:
                results.append({"error": "returned %s, outside the 0-5 range" % number})
            else:
                results.append(number)
    except Exception as exc:
        results.append({"error": "%s: %s" % (type(exc).__name__, exc)})
print(json.dumps(results))
`;

// filter(text) rewrites the whole article once; a filter that returns a
// non-string is rejected so the next stage never sees an object by accident.
const FILTER_RUNNER = String.raw`
import contextlib
import importlib.util
import json
import sys

def fail(message):
    print(json.dumps({"error": message}))
    sys.exit(0)

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("ype_filter", path)
if spec is None or spec.loader is None:
    fail("failed to load the filter file")
module = importlib.util.module_from_spec(spec)
try:
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
except Exception as exc:
    fail("filter failed to import: %s: %s" % (type(exc).__name__, exc))
fn = getattr(module, "filter", None)
if not callable(fn):
    fail("the script must define a callable filter(text)")

payload = json.load(sys.stdin)
try:
    with contextlib.redirect_stdout(sys.stderr):
        value = fn(payload["text"])
except Exception as exc:
    fail("%s: %s" % (type(exc).__name__, exc))
if not isinstance(value, str):
    fail("filter(text) must return a string")
print(json.dumps({"text": value}))
`;

async function writeTempScript(code) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-ype-'));
  const file = join(tempDir, 'rule.py');
  await writeFile(file, code, 'utf8');
  return { file, tempDir };
}

function spawnPython({ python, file, cwd, payload, timeoutMs, signal, runner }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    let child;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      callback(value);
    };

    try {
      child = spawn(python, ['-c', runner, file], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      reject(new Error(`cannot start python (${python}): ${error.message}`));
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });

    child.on('error', (error) => {
      if (error.name === 'AbortError' || signal?.aborted) {
        finish(reject, new Error('script was cancelled'));
        return;
      }
      if (error.code === 'ENOENT') {
        finish(reject, new Error(`python interpreter "${python}" was not found; set config.python`));
        return;
      }
      finish(reject, error);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 400);
        finish(reject, new Error(`script exited with code ${code}${detail.length > 0 ? `: ${detail}` : ''}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        finish(reject, new Error(`script output is not JSON: ${stdout.trim().slice(0, 200)}`));
        return;
      }
      resolve(parsed);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function withTempScript(code, run) {
  const { file, tempDir } = await writeTempScript(code);
  try {
    return await run(file);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runScriptRule({ script, paragraphs, python, cwd, timeoutMs, signal }) {
  const execute = (file) =>
    spawnPython({ python, file, cwd, payload: paragraphs, timeoutMs, signal, runner: CHECK_RUNNER });
  const parsed = script.path === undefined ? await withTempScript(script.code, execute) : await execute(script.path);

  if (!Array.isArray(parsed) || parsed.length !== paragraphs.length) {
    throw new Error('the script returned a different number of results than paragraphs');
  }
  const scores = [];
  const errors = [];
  parsed.forEach((entry, index) => {
    if (entry === null) {
      scores.push(null);
      return;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      scores.push(entry);
      return;
    }
    scores.push(null);
    errors.push({ index, message: typeof entry?.error === 'string' ? entry.error : 'unknown script error' });
  });
  return { scores, errors };
}

export async function runFilterScript({ script, text, python, cwd, timeoutMs, signal }) {
  const execute = (file) =>
    spawnPython({ python, file, cwd, payload: { text }, timeoutMs, signal, runner: FILTER_RUNNER });
  const parsed = script.path === undefined ? await withTempScript(script.code, execute) : await execute(script.path);

  if (typeof parsed?.error === 'string') throw new Error(parsed.error);
  if (typeof parsed?.text !== 'string') throw new Error('the filter did not return text');
  return parsed.text;
}
