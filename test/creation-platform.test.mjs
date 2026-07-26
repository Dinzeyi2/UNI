import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateBehaviorSpecification } from '../behavior-schema.mjs';
import { compileIntentWithLlm } from '../intent-compiler.mjs';
import { LocalBehaviorRuntime } from '../local-agent/runtime.mjs';
import { CloudAgentSync } from '../local-agent/cloud-sync.mjs';

const devices = [{ deviceId: 'primary', name: 'Living light', capabilities: ['light.set_brightness'], online: true }, { deviceId: 'fallback', name: 'Kitchen light', capabilities: ['light.set_brightness'], online: true }];
const behavior = { behaviorId: 'cozy', name: 'Cozy room', goal: 'Create a cozy room', triggers: [{ type: 'desk.occupied', deviceId: null, event: null }], conditions: [], actions: [{ deviceId: 'primary', capability: 'light.set_brightness', parameters: { percent: 30 }, reason: 'Warm low light' }], fallbacks: [{ forAction: 0, when: 'offline', action: { deviceId: 'fallback', capability: 'light.set_brightness', parameters: { percent: 20 }, reason: 'Preserve ambient light' } }], safeguards: ['preserve_manual_override'], termination: [] };

test('rejects AI actions that invent unavailable devices', () => {
  const invalid = structuredClone(behavior); invalid.actions[0].deviceId = 'invented';
  assert.equal(validateBehaviorSpecification(invalid, devices).valid, false);
});

test('structured compiler validates model output against the environment', async () => {
  const previous = [process.env.LLM_API_URL, process.env.LLM_API_KEY, process.env.LLM_MODEL];
  Object.assign(process.env, { LLM_API_URL: 'https://compiler.invalid/v1/chat', LLM_API_KEY: 'test', LLM_MODEL: 'structured-test' });
  try { const result = await compileIntentWithLlm({ intent: 'Make it cozy', devices, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(behavior) } }] }) }) }); assert.equal(result.actions[0].deviceId, 'primary'); assert.equal(result.compiler.type, 'structured_llm'); }
  finally { ['LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL'].forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test('local runtime uses a compiled fallback when the primary action fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-runtime-'));
  try { const inventory = { list: () => devices.map(device => ({ ...device, discoveryId: device.deviceId, adapter: 'hue_bridge' })) }; const executed = []; const runtime = new LocalBehaviorRuntime(join(directory, 'runtime.json'), inventory, async device => { executed.push(device.discoveryId); if (device.discoveryId === 'primary') throw new Error('offline'); return { acknowledged: true }; }); runtime.deploy(behavior); const runs = await runtime.dispatch({ type: 'desk.occupied', value: true }); assert.deepEqual(executed, ['primary', 'primary', 'primary', 'fallback']); assert.equal(runs[0].results[0].fallback, true); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('manual overrides suppress behavior actions without fighting the user', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-override-')); const executed = [];
  try { const inventory = { list: () => devices.map(device => ({ ...device, discoveryId: device.deviceId, adapter: 'hue_bridge' })) }; const runtime = new LocalBehaviorRuntime(join(directory, 'runtime.json'), inventory, async device => executed.push(device.discoveryId)); runtime.deploy(behavior); await runtime.dispatch({ type: 'device.manual_override', deviceId: 'primary', holdMinutes: 10 }); const runs = await runtime.dispatch({ type: 'desk.occupied' }); assert.equal(runs[0].results[0].reason, 'manual_override'); assert.deepEqual(executed, []); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('outbound cloud sync uploads inventory and deploys returned behavior', async () => {
  const deployed = []; let request;
  const sync = new CloudAgentSync({ baseUrl: 'https://nexus.example', token: 'agent-token', inventory: { list: () => [{ discoveryId: 'primary', hostname: 'Living light', adapter: 'hue_bridge', capabilities: ['light.set_brightness'], status: 'online' }] }, runtime: { list: () => [], deploy: value => deployed.push(value) }, fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ behaviors: [{ ...behavior, version: 1, status: 'deployed' }] }) }; } });
  await sync.synchronize();
  assert.equal(request.url, 'https://nexus.example/api/agent/sync');
  assert.equal(JSON.parse(request.options.body).inventory[0].deviceId, 'primary');
  assert.equal(deployed[0].behaviorId, 'cozy');
});
