import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyDevice, parseSsdpMessage } from '../local-agent/discovery.mjs';
import { LocalInventory } from '../local-agent/inventory.mjs';
import { AdapterRegistry } from '../local-agent/plugin-registry.mjs';

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
