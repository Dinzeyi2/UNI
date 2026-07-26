import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { discoverLocal, localIpv4Networks } from './local-agent/discovery.mjs';
import { createDefaultAdapterRegistry } from './local-agent/adapters.mjs';
import { LocalInventory } from './local-agent/inventory.mjs';
import { LocalBehaviorRuntime } from './local-agent/runtime.mjs';
import { compileIntentWithLlm } from './intent-compiler.mjs';
import { CloudAgentSync } from './local-agent/cloud-sync.mjs';
import { configuredBridgeAdapters } from './local-agent/bridge-adapters.mjs';
import { configuredHomeAssistantLocalAdapter } from './local-agent/home-assistant-adapter.mjs';

const port = Number(process.env.NEXUS_AGENT_PORT || 4180);
const host = process.env.NEXUS_AGENT_HOST || '127.0.0.1';
const token = process.env.NEXUS_AGENT_TOKEN;
const secret = process.env.NEXUS_AGENT_SECRET;
if (!token || token.length < 24 || !secret || secret.length < 24) throw new Error('NEXUS_AGENT_TOKEN and NEXUS_AGENT_SECRET must each contain at least 24 characters');
const inventory = new LocalInventory(process.env.NEXUS_AGENT_STATE || join(process.cwd(), '.nexus-local-agent.json'), secret);
const adapters = createDefaultAdapterRegistry();
const homeAssistantLocal = configuredHomeAssistantLocalAdapter();
if (homeAssistantLocal) adapters.register(homeAssistantLocal);
for (const adapter of configuredBridgeAdapters()) adapters.register(adapter);
for (const modulePath of String(process.env.NEXUS_ADAPTER_MODULES || '').split(',').map(value => value.trim()).filter(Boolean)) { const plugin = await import(modulePath); adapters.register(plugin.default || plugin.adapter); }
const executeLocal = (device, action, state) => adapters.execute(device, action, state);
const runtime = new LocalBehaviorRuntime(process.env.NEXUS_AGENT_RUNTIME_STATE || join(process.cwd(), '.nexus-local-runtime.json'), inventory, executeLocal);
runtime.start();
const cloudSync = new CloudAgentSync({ baseUrl: process.env.NEXUS_CLOUD_URL, token: process.env.NEXUS_CLOUD_AGENT_TOKEN, inventory, runtime, intervalMs: Number(process.env.NEXUS_CLOUD_SYNC_INTERVAL_MS || 10_000) });
cloudSync.start();
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
const read = request => new Promise((resolve, reject) => { let raw = ''; request.on('data', chunk => { raw += chunk; if (raw.length > 100_000) reject(new Error('Request too large')); }); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } }); });
function authorized(request) { const supplied = request.headers.authorization?.replace(/^Bearer /, '') || ''; const expected = Buffer.from(token); const received = Buffer.from(supplied); return expected.length === received.length && timingSafeEqual(expected, received); }
function compilerDevices() { return inventory.list().map(device => ({ deviceId: device.discoveryId, name: device.hostname || device.server || device.discoveryId, room: device.room || 'Unassigned', type: device.adapter || 'unknown', online: device.status !== 'offline', capabilities: device.capabilities || (device.adapter === 'hue_bridge' ? ['light.turn_on', 'light.turn_off', 'light.set_brightness', 'light.set_temperature'] : device.adapter === 'shelly' ? ['light.turn_on', 'light.turn_off'] : []), reportedState: device.reportedState || {} })); }

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/health') return send(response, 200, { status: 'ok', mode: 'local-first', networks: localIpv4Networks().length });
    if (!authorized(request)) return send(response, 401, { error: 'Agent authentication required' });
    if (request.method === 'GET' && url.pathname === '/inventory') return send(response, 200, inventory.list());
    if (request.method === 'POST' && url.pathname === '/discover') { const [lan, controller] = await Promise.all([discoverLocal(), adapters.discover()]); return send(response, 200, inventory.merge([...lan.map(device => adapters.classify(device)), ...controller])); }
    if (request.method === 'GET' && url.pathname === '/adapters') return send(response, 200, adapters.list());
    if (request.method === 'POST' && url.pathname.match(/^\/pair\/[^/]+$/)) { const input = await read(request); const requested = url.pathname.split('/').pop(); const adapterId = requested === 'hue' ? 'hue_bridge' : requested; const device = inventory.list().find(item => item.discoveryId === input.deviceId); if (!device) return send(response, 404, { error: 'Discovered device not found' }); return send(response, 200, await adapters.pair(adapterId, device, inventory, input)); }
    if (request.method === 'POST' && url.pathname === '/execute') { const input = await read(request); const device = inventory.list().find(item => item.discoveryId === input.deviceId); if (!device) return send(response, 404, { error: 'Discovered device not found' }); if (!input.action?.capability) return send(response, 400, { error: 'action.capability is required' }); return send(response, 200, await executeLocal(device, input.action, inventory)); }
    if (request.method === 'POST' && url.pathname === '/create') { const input = await read(request); if (!String(input.intent || '').trim()) return send(response, 400, { error: 'intent is required' }); const behavior = await compileIntentWithLlm({ intent: input.intent, devices: compilerDevices(), context: input.context || [] }); return send(response, 201, { behaviorId: randomUUID(), status: 'proposal', ...behavior }); }
    if (request.method === 'GET' && url.pathname === '/behaviors') return send(response, 200, runtime.list());
    if (request.method === 'POST' && url.pathname === '/behaviors/deploy') return send(response, 201, runtime.deploy(await read(request)));
    if (request.method === 'POST' && url.pathname.match(/^\/behaviors\/[^/]+\/pause$/)) return send(response, 200, runtime.pause(url.pathname.split('/')[2]));
    if (request.method === 'POST' && url.pathname === '/events') return send(response, 202, { accepted: true, runs: await runtime.dispatch(await read(request)) });
    return send(response, 404, { error: 'Not found' });
  } catch (error) { return send(response, 400, { error: error.message }); }
}).listen(port, host, () => console.log(`Nexus local agent listening on http://${host}:${port}`));
