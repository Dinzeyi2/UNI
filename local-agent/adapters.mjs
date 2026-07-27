import net from 'node:net';
import { AdapterRegistry } from './plugin-registry.mjs';

function privateAddress(address) {
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

async function localFetch(address, path, options = {}) {
  if (!privateAddress(address)) throw new Error('Local adapters may only contact private IPv4 addresses');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`http://${address}${path}`, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Local device rejected the request (${response.status})`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}

export async function pairHue(device, inventory) {
  const result = await localFetch(device.address, '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ devicetype: 'nexus_local_agent' }) });
  const username = result?.[0]?.success?.username;
  if (!username) throw new Error(result?.[0]?.error?.description || 'Press the Hue Bridge link button, then retry pairing.');
  inventory.storeCredential('hue_bridge', device.discoveryId, { username });
  const lights = await localFetch(device.address, `/api/${username}/lights`);
  const discovered = Object.entries(lights || {}).map(([lightId, light]) => ({ discoveryId: `${device.discoveryId}:light:${lightId}`, controllerId: device.discoveryId, address: device.address, hostname: light.name, protocol: 'hue_local', serviceType: 'hue_light', adapter: 'hue_bridge', tier: 'local_standard', reason: 'Paired through the local Hue Bridge.', capabilities: ['light.turn_on', 'light.turn_off', 'light.set_brightness', 'light.set_temperature'], localTarget: { lightId }, reportedState: light.state || {}, observedAt: new Date().toISOString() }));
  inventory.merge(discovered);
  return { paired: true, adapter: 'hue_bridge', deviceId: device.discoveryId, imported: discovered.length, devices: discovered };
}

export async function executeHue(device, action, inventory) {
  const credential = inventory.credential('hue_bridge', device.controllerId || device.discoveryId);
  if (!credential) throw new Error('Hue Bridge is not paired');
  const lightId = action.target?.lightId || device.localTarget?.lightId;
  if (!/^\d+$/.test(String(lightId || ''))) throw new Error('Hue actions require target.lightId');
  const state = {};
  if (action.capability === 'light.turn_on') state.on = true;
  else if (action.capability === 'light.turn_off') state.on = false;
  else if (action.capability === 'light.set_brightness') state.bri = Math.round(action.parameters.percent * 2.54);
  else if (action.capability === 'light.set_temperature') state.ct = Math.round(1_000_000 / action.parameters.kelvin);
  else throw new Error(`Unsupported Hue capability: ${action.capability}`);
  const result = await localFetch(device.address, `/api/${credential.username}/lights/${lightId}/state`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
  return { acknowledged: true, adapter: 'hue_bridge', result };
}

export async function executeShelly(device, action) {
  if (!['light.turn_on', 'light.turn_off'].includes(action.capability)) throw new Error(`Unsupported Shelly capability: ${action.capability}`);
  const on = action.capability === 'light.turn_on';
  const id = Number(action.target?.channel || 0);
  const result = await localFetch(device.address, `/rpc/Switch.Set?id=${id}&on=${on}`);
  return { acknowledged: true, adapter: 'shelly', result };
}

async function verifyHue(device, action, inventory) { const credential = inventory.credential('hue_bridge', device.controllerId || device.discoveryId); const lightId = device.localTarget?.lightId; if (!credential || !lightId) return { confirmed: false, reason: 'Pairing or light target unavailable' }; const light = await localFetch(device.address, `/api/${credential.username}/lights/${lightId}`); const state = light?.state || {}; const confirmed = action.capability === 'light.turn_on' ? state.on === true : action.capability === 'light.turn_off' ? state.on === false : action.capability === 'light.set_brightness' ? Math.abs((state.bri || 0) - Math.round(action.parameters.percent * 2.54)) <= 2 : action.capability === 'light.set_temperature' ? Math.abs((state.ct || 0) - Math.round(1_000_000 / action.parameters.kelvin)) <= 2 : false; return { confirmed, reportedState: state }; }
async function verifyShelly(device, action) { const id = Number(action.target?.channel || 0); const state = await localFetch(device.address, `/rpc/Switch.GetStatus?id=${id}`); const desired = action.capability === 'light.turn_on'; return { confirmed: state?.output === desired, reportedState: state }; }

export function createDefaultAdapterRegistry() { return new AdapterRegistry()
  .register({ id: 'hue_bridge', name: 'Philips Hue (local bridge)', canPair: true, match: device => /hue|philips|ipbridge|hue_light/.test(`${device.serviceType || ''} ${device.server || ''}`.toLowerCase()), capabilities: ['light.turn_on', 'light.turn_off', 'light.set_brightness', 'light.set_temperature'], pair: pairHue, execute: executeHue, verify: verifyHue })
  .register({ id: 'shelly', name: 'Shelly local RPC', match: device => /shelly/.test(`${device.serviceType || ''} ${device.server || ''}`.toLowerCase()), capabilities: ['light.turn_on', 'light.turn_off'], execute: executeShelly, verify: verifyShelly }); }

export async function executeLocal(device, action, inventory) {
  return createDefaultAdapterRegistry().execute(device, action, inventory);
}
