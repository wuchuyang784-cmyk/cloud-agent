import { ModelAccessError } from './errors.mjs';

const unavailable = () => { throw new ModelAccessError('model_upstream_unavailable'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 256) => typeof value === 'string' && value.length <= max;
const encode = value => 'data: ' + JSON.stringify(value) + '\n\n';
function projectDelta(value) {
  if (!object(value)) unavailable();
  const result = {};
  if (value.role !== undefined) { if (value.role !== 'assistant') unavailable(); result.role = value.role; }
  for (const field of ['content', 'reasoning_content']) if (value[field] !== undefined) {
    if (value[field] !== null && typeof value[field] !== 'string') unavailable(); result[field] = value[field];
  }
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls) || value.tool_calls.length > 64) unavailable();
    result.tool_calls = value.tool_calls.map(tool => {
      if (!object(tool) || !Number.isInteger(tool.index) || tool.index < 0 || tool.index >= 64) unavailable();
      const selected = { index: tool.index };
      if (tool.id !== undefined) { if (!text(tool.id, 128)) unavailable(); selected.id = tool.id; }
      if (tool.type !== undefined) { if (tool.type !== 'function') unavailable(); selected.type = tool.type; }
      if (tool.function !== undefined) {
        if (!object(tool.function)) unavailable(); selected.function = {};
        for (const field of ['name', 'arguments']) if (tool.function[field] !== undefined) {
          if (typeof tool.function[field] !== 'string' || field === 'name' && !text(tool.function[field], 128)) unavailable(); selected.function[field] = tool.function[field];
        }
      }
      return selected;
    });
  }
  return result;
}

export async function forwardModelStream(source, { secrets = [], write, finish, signal, limits = {} }) {
  const maxEvent = limits.maxEventBytes ?? 262144, maxTotal = limits.maxOutputBytes ?? 4194304;
  if (!Number.isInteger(maxEvent) || maxEvent < 1 || maxEvent > 262144 || !Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > 4194304) throw new ModelAccessError('model_access_configuration_invalid');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', received = 0, emitted = 0, terminal = null, usageFrame = null, usage = null, usageCount = 0;
  const send = async value => {
    if (signal?.aborted) unavailable();
    emitted += Buffer.byteLength(value); if (emitted > maxTotal) throw new ModelAccessError('model_gateway_limit');
    await write(value);
  };
  const frame = async raw => {
    if (Buffer.byteLength(raw) > maxEvent) throw new ModelAccessError('model_gateway_limit');
    const lines = raw.split('\n'), data = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (!/^(?:id:|retry:|event:\s*message\s*$)/.test(line)) unavailable();
    }
    if (!data.length) return false;
    let content = data.join('\n');
    for (const secret of secrets) if (typeof secret === 'string' && secret.length) content = content.split(secret).join('[REDACTED]');
    if (content === '[DONE]') {
      if (!terminal) unavailable();
      const known = usageCount === 1 && usage !== null;
      try { await finish({ state: 'completed', inputTokens: known ? usage.prompt_tokens : null, outputTokens: known ? usage.completion_tokens : null }); }
      catch { throw new ModelAccessError('model_access_unavailable'); }
      await send(encode(terminal));
      if (known) await send(encode({ ...usageFrame, usage }));
      await send('data: [DONE]\n\n'); return true;
    }
    let value; try { value = JSON.parse(content); } catch { unavailable(); }
    if (!object(value) || Object.hasOwn(value, 'error') || value.object !== 'chat.completion.chunk' || !text(value.id) || !text(value.model, 128) || !count(value.created)
      || !Array.isArray(value.choices) || value.choices.length > 1) unavailable();
    const projected = { id: value.id, object: value.object, created: value.created, model: value.model, choices: [] };
    if (value.usage !== undefined && value.usage !== null) {
      usageCount++;
      const u = value.usage;
      const finalReport = terminal !== null || value.choices.some(choice => object(choice) && choice.finish_reason);
      if (finalReport && object(u) && count(u.prompt_tokens) && count(u.completion_tokens) && count(u.prompt_tokens + u.completion_tokens)
        && (u.total_tokens === undefined || u.total_tokens === u.prompt_tokens + u.completion_tokens)) {
        usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens };
      } else usage = null;
      usageFrame = { ...projected, choices: [] };
    }
    for (const choice of value.choices) {
      if (!object(choice) || choice.index !== 0 || terminal || ![null, undefined, 'stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason)) unavailable();
      projected.choices.push({ index: 0, delta: projectDelta(choice.delta), finish_reason: choice.finish_reason ?? null });
      if (choice.finish_reason) terminal = projected;
    }
    if (projected.choices.length && terminal !== projected) await send(encode(projected));
    return false;
  };
  try {
    for await (const bytes of source) {
      if (signal?.aborted) unavailable();
      received += Buffer.byteLength(bytes); if (received > maxTotal) throw new ModelAccessError('model_gateway_limit');
      pending = (pending + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        if (await frame(raw)) return;
      }
      if (Buffer.byteLength(pending) > maxEvent) throw new ModelAccessError('model_gateway_limit');
    }
    decoder.decode(); unavailable();
  } catch (error) { throw error instanceof ModelAccessError ? error : new ModelAccessError('model_upstream_unavailable'); }
}
