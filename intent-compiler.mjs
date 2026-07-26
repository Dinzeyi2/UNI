import { behaviorJsonSchema, CAPABILITY_REGISTRY, validateBehaviorSpecification } from './behavior-schema.mjs';

const SYSTEM_PROMPT = `You are the Nexus environment compiler. Convert a human goal into one safe structured Behavior. Use only the supplied deviceIds and their listed capabilities. Never invent a device, capability, credential, URL, or provider command. Prefer reversible low-risk actions. Add fallbacks only when an equivalent real device exists. The result is a proposal and must never claim it already executed.`;

export async function compileIntentWithLlm({ intent, devices, context = [], fetchImpl = fetch }) {
  if (!process.env.LLM_API_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) throw new Error('LLM compiler is not configured');
  const response = await fetchImpl(process.env.LLM_API_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.LLM_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0.2, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify({ intent, devices: devices.map(({ deviceId, name, room, type, online, capabilities, reportedState }) => ({ deviceId, name, room, type, online, capabilities, reportedState })), context, capabilityRegistry: CAPABILITY_REGISTRY }) }], response_format: { type: 'json_schema', json_schema: behaviorJsonSchema } }) });
  if (!response.ok) throw new Error(`LLM compiler failed (${response.status})`);
  const payload = await response.json(); const content = payload.choices?.[0]?.message?.content;
  const specification = typeof content === 'string' ? JSON.parse(content) : content;
  const validation = validateBehaviorSpecification(specification, devices);
  if (!validation.valid) throw new Error(`LLM returned an ungrounded Behavior: ${validation.issues.join('; ')}`);
  return { ...specification, requiredCapabilities: [...new Set(specification.actions.map(action => action.capability))], compiler: { type: 'structured_llm', model: process.env.LLM_MODEL } };
}
