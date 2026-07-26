import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyDevice, parseSsdpMessage } from '../local-agent/discovery.mjs';
import { LocalInventory } from '../local-agent/inventory.mjs';
import { AdapterRegistry } from '../local-agent/plugin-registry.mjs';
import { createDefaultAdapterRegistry } from '../local-agent/adapters.mjs';
import { configuredBridgeAdapters } from '../local-agent/bridge-adapters.mjs';
import { createHomeAssistantLocalAdapter } from '../local-agent/home-assistant-adapter.mjs';

test('parses and classifies a Hue SSDP response', () => {
  const response = ['HTTP/1.1 200 OK', 'LOCATION: http://192.168.1.20/description.xml', 'SERVER: Linux/3.14 UPnP/1.0 IpBridge/1.56.0', 'ST: upnp:rootdevice', 'USN: uuid:hue-bridge::upnp:rootdevice', '', ''].join('\r\n');
  const device = parseSsdpMessage(response, { address: '192.168.1.20' });
  assert.equal(device.address, '192.168.1.20');
  assert.deepEqual(classifyDevice(device), { tier: 'secure_pairing', adapter: 'hue_bridge', reason: 'Press the Hue Bridge link button to authorize local control.' });
});

test('unknown devices remain visible but locked', () => {
  const result = classifyDevice({ serviceType: 'vendor:unknown', server: 'ProprietaryThing' });
  assert.equal(result.tier, 'locked_or_unknown');
  assert.equal(result.adapter, null);
});

test('inventory persists devices and encrypts pairing credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexus-agent-'));
  try {
    const path = join(directory, 'state.json');
    const inventory = new LocalInventory(path, 'a-development-test-secret-that-is-long');
    inventory.merge([{ discoveryId: 'bridge-1', observedAt: new Date().toISOString(), address: '192.168.1.20' }]);
    inventory.storeCredential('hue_bridge', 'bridge-1', { username: 'local-pairing-token' });
    const restored = new LocalInventory(path, 'a-development-test-secret-that-is-long');
    assert.equal(restored.list()[0].status, 'online');
    assert.deepEqual(restored.credential('hue_bridge', 'bridge-1'), { username: 'local-pairing-token' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('adapter plugins classify, execute, and verify normalized actions', async () => {
  const registry = new AdapterRegistry().register({ id: 'test_light', name: 'Test light', match: device => device.protocol === 'test', capabilities: ['light.turn_on'], execute: async () => ({ acknowledged: true }), verify: async () => ({ confirmed: true }) });
  const device = registry.classify({ discoveryId: 'test-1', protocol: 'test' });
  assert.equal(device.adapter, 'test_light');
  assert.equal(device.executable, true);
  const result = await registry.execute(device, { capability: 'light.turn_on', parameters: {} }, {});
  assert.equal(result.verification.confirmed, true);
  assert.throws(() => registry.register({ id: 'test_light', name: 'Duplicate', match: () => true, capabilities: [], execute: async () => ({}) }), /already registered/);
});

test('adapter verification rejects unconfirmed physical state', async () => {
  const registry = new AdapterRegistry().register({ id: 'unconfirmed', name: 'Unconfirmed adapter', match: () => true, capabilities: ['light.turn_on'], execute: async () => ({ acknowledged: true }), verify: async () => ({ confirmed: false, reason: 'still off' }) });
  await assert.rejects(() => registry.execute({ adapter: 'unconfirmed' }, { capability: 'light.turn_on' }, {}), /state unconfirmed/);
});

test('Sonos adapter sends local SOAP and verifies reported playback', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const verification = options.headers.soapaction.includes('GetTransportInfo');
    return { ok: true, status: 200, headers: { get: () => 'text/xml' }, text: async () => verification ? '<CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState>' : '<ok/>' };
  };
  try {
    const registry = createDefaultAdapterRegistry();
    const result = await registry.execute({ adapter: 'sonos', address: '192.168.1.40' }, { capability: 'speaker.pause', parameters: {} }, {});
    assert.equal(result.verification.confirmed, true);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^http:\/\/192\.168\.1\.40:1400\//);
  } finally { globalThis.fetch = previousFetch; }
});

test('Matter and HomeKit bridges require authenticated loopback services', () => {
  assert.throws(() => configuredBridgeAdapters({ MATTER_BRIDGE_URL: 'https://example.com', MATTER_BRIDGE_TOKEN: 'secret' }), /loopback/);
  const adapters = configuredBridgeAdapters({ MATTER_BRIDGE_URL: 'http://127.0.0.1:5580', MATTER_BRIDGE_TOKEN: 'matter-secret', HOMEKIT_BRIDGE_URL: 'http://localhost:5581', HOMEKIT_BRIDGE_TOKEN: 'homekit-secret' });
  assert.deepEqual(adapters.map(adapter => adapter.id), ['matter', 'homekit']);
  assert.ok(adapters.every(adapter => adapter.canPair));
});

test('local Home Assistant discovers, executes, and verifies controller entities', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const path = new URL(url).pathname;
    const payload = path === '/api/states' ? [{ entity_id: 'light.matter_lamp', state: 'on', attributes: { friendly_name: 'Matter Lamp', brightness: 128, color_temp_kelvin: 2700 }, last_updated: '2026-01-01T00:00:00Z' }] : path === '/api/states/light.matter_lamp' ? { entity_id: 'light.matter_lamp', state: 'on', attributes: { brightness: 51 } } : [];
    return { ok: true, status: 200, json: async () => payload };
  };
  const adapter = createHomeAssistantLocalAdapter({ baseUrl: 'http://192.168.1.2:8123', token: 'local-token', fetchImpl });
  const [device] = await adapter.discover();
  assert.equal(device.discoveryId, 'ha:light.matter_lamp');
  assert.ok(device.capabilities.includes('light.set_brightness'));
  await adapter.execute(device, { capability: 'light.set_brightness', parameters: { percent: 20 } });
  const verification = await adapter.verify(device, { capability: 'light.set_brightness', parameters: { percent: 20 } });
  assert.equal(verification.confirmed, true);
  assert.match(requests[1].url, /\/api\/services\/light\/turn_on$/);
  assert.deepEqual(JSON.parse(requests[1].options.body), { entity_id: 'light.matter_lamp', brightness_pct: 20 });
});

test('local Home Assistant refuses public controller addresses', () => {
  assert.throws(() => createHomeAssistantLocalAdapter({ baseUrl: 'https://public.example.com', token: 'secret' }), /must use/);
});
