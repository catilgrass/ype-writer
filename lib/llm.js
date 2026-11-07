// Model-call helpers. The plugin talks to ctx.llm directly instead of spawning
// subagents: a scoring session is one auxiliary call, so cost and latency stay
// predictable and the session log stays clean. All calls share one streaming
// shell, one deadline, and one failure vocabulary.

// Route precedence is plugin config, then the calling agent, then the profile
// default: an explicit row config must win over a session override.
export function resolveModelRoute(ctx, exec, config) {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort };
  }
  const agent = exec?.agent?.options;
  if (agent?.provider !== undefined && agent?.model !== undefined) {
    return { provider: agent.provider, model: agent.model, reasoningEffort: agent.reasoningEffort };
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection();
  if (fallback?.provider !== undefined && fallback?.model !== undefined) {
    return { provider: fallback.provider, model: fallback.model, reasoningEffort: fallback.reasoningEffort };
  }
  throw new Error('Cannot resolve a model route: set provider/model in the plugin config, or select a default model first');
}

// Models wrap JSON in fences often enough that accepting one fence is cheaper
// than failing a whole session.
function unfence(text) {
  const body = text.trim();
  const match = /^```[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n```$/.exec(body);
  return match === null ? body : match[1].trim();
}

// Prose around the payload is tolerated because sessions sometimes explain
// themselves; a truncated payload must fail so a half score is never used.
export function extractJson(text, label = 'model response') {
  const body = unfence(text);
  const objectStart = body.indexOf('{');
  const arrayStart = body.indexOf('[');
  let start;
  if (objectStart < 0) start = arrayStart;
  else if (arrayStart < 0) start = objectStart;
  else start = Math.min(objectStart, arrayStart);
  if (start < 0) throw new Error(`${label}: no JSON in the response`);

  const stack = [];
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char === '}' || char === ']') {
      const open = stack.pop();
      if (open === undefined) break;
      if ((open === '{') !== (char === '}')) break;
      if (stack.length === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${label}: JSON is incomplete`);
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`${label}: failed to parse JSON (${error.message})`);
  }
}

async function streamText(ctx, { route, system, user, maxTokens, timeoutMs, signal, label }) {
  const llm = ctx.get('llm');
  if (llm === undefined) throw new Error('llm service unavailable: this composition does not mount @deepseek-ai/dsh-llm');
  if (signal?.aborted) throw new Error(`${label}: cancelled`);

  const deadline = AbortSignal.timeout(timeoutMs);
  const fused = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  let text = '';
  let finish;
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens,
      signal: fused,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    if (signal?.aborted) throw new Error(`${label}: cancelled`);
    if (deadline.aborted) throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (finish === undefined) throw new Error(`${label}: model stream did not finish`);
  if (finish.kind !== 'stop') {
    if (finish.kind === 'max-tokens') throw new Error(`${label}: output hit maxOutputTokens; raise it or shorten the article`);
    if (finish.kind === 'tool-calls') throw new Error(`${label}: model unexpectedly requested tools`);
    throw new Error(`${label}: ${finish.failure?.message ?? finish.kind}`);
  }
  return text.trim();
}

export async function callJson(ctx, options) {
  const text = await streamText(ctx, options);
  return extractJson(text, options.label);
}

// The inference session returns prose by design, so only emptiness is fatal.
export async function callText(ctx, options) {
  const text = await streamText(ctx, options);
  if (text.length === 0) throw new Error(`${options.label}: model returned no text`);
  return text;
}
