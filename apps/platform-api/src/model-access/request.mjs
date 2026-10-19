import { ModelAccessError } from './errors.mjs';
import { isModelId } from './validation.mjs';
const invalid = () => { throw new ModelAccessError('invalid_model_input'); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); };
const name = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(value);
export function validateModelRequest(value) {
  fields(value, ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options', 'stop', 'n', 'store']);
  if (!isModelId(value.model) || value.stream !== true || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 128) invalid();
  for (const message of value.messages) {
    fields(message, ['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) invalid();
    if (message.content !== null && typeof message.content !== 'string') {
      if (!Array.isArray(message.content) || message.content.length > 128) invalid();
      for (const part of message.content) { fields(part, ['type', 'text']); if (part.type !== 'text' || typeof part.text !== 'string') invalid(); }
    }
    if (message.name !== undefined && !name(message.name) || message.tool_call_id !== undefined && (typeof message.tool_call_id !== 'string' || message.tool_call_id.length > 128)) invalid();
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length > 64) invalid();
      for (const tool of message.tool_calls) {
        fields(tool, ['id', 'type', 'function']); fields(tool.function, ['name', 'arguments']);
        if (typeof tool.id !== 'string' || tool.id.length > 128 || tool.type !== 'function' || !name(tool.function.name) || typeof tool.function.arguments !== 'string') invalid();
      }
    }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 64) invalid();
    for (const tool of value.tools) {
      fields(tool, ['type', 'function']); fields(tool.function, ['name', 'description', 'parameters', 'strict']);
      if (tool.type !== 'function' || !name(tool.function.name) || tool.function.description !== undefined && typeof tool.function.description !== 'string'
        || tool.function.parameters !== undefined && !record(tool.function.parameters) || tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean') invalid();
    }
  }
  if (value.tool_choice !== undefined && !['auto', 'none', 'required'].includes(value.tool_choice)) {
    fields(value.tool_choice, ['type', 'function']); fields(value.tool_choice.function, ['name']);
    if (value.tool_choice.type !== 'function' || !name(value.tool_choice.function.name)) invalid();
  }
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== 'boolean' || value.n !== undefined && value.n !== 1 || value.store !== undefined && value.store !== false) invalid();
  for (const [field, maximum] of [['temperature', 2], ['top_p', 1]]) if (value[field] !== undefined && (!Number.isFinite(value[field]) || value[field] < 0 || value[field] > maximum)) invalid();
  if (value.stop !== undefined && !(typeof value.stop === 'string' && value.stop.length <= 256) && !(Array.isArray(value.stop) && value.stop.length <= 4 && value.stop.every(item => typeof item === 'string' && item.length <= 256))) invalid();
  if (value.stream_options !== undefined) { fields(value.stream_options, ['include_usage']); if (typeof value.stream_options.include_usage !== 'boolean') invalid(); }
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) invalid();
  const tokenField = value.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens', requested = value[tokenField] ?? 4096;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 65536) invalid();
  // pi's reviewed model catalog advertises a larger maximum. Bound it at this
  // trusted boundary, without changing F1 or passing a larger Provider budget.
  return { ...value, [tokenField]: Math.min(4096, requested), stream_options: { include_usage: true } };
}
