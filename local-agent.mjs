import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { discoverLocal, localIpv4Networks } from './local-agent/discovery.mjs';
import { executeLocal, pairHue } from './local-agent/adapters.mjs';
import { LocalInventory } from './local-agent/inventory.mjs';

const port = Number(process.env.NEXUS_AGENT_PORT || 4180);
const host = process.env.NEXUS_AGENT_HOST || '127.0.0.1';
const token = process.env.NEXUS_AGENT_TOKEN;
const secret = process.env.NEXUS_AGENT_SECRET;
if (!token || token.length < 24 || !secret || secret.length < 24) throw new Error('NEXUS_AGENT_TOKEN and NEXUS_AGENT_SECRET must each contain at least 24 characters');
const inventory = new LocalInventory(process.env.NEXUS_AGENT_STATE || join(process.cwd(), '.nexus-local-agent.json'), secret);
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
const read = request => new Promise((resolve, reject) => { let raw = ''; request.on('data', chunk => { raw += chunk; if (raw.length > 100_000) reject(new Error('Request too large')); }); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } }); });
function authorized(request) { const supplied = request.headers.authorization?.replace(/^Bearer /, '') || ''; const expected = Buffer.from(token); const received = Buffer.from(supplied); return expected.length === received.length && timingSafeEqual(expected, received); }

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/health') return send(response, 200, { status: 'ok', mode: 'local-first', networks: localIpv4Networks().length });
    if (!authorized(request)) return send(response, 401, { error: 'Agent authentication required' });
    if (request.method === 'GET' && url.pathname === '/inventory') return send(response, 200, inventory.list());
    if (request.method === 'POST' && url.pathname === '/discover') return send(response, 200, inventory.merge(await discoverLocal()));
    if (request.method === 'POST' && url.pathname === '/pair/hue') { const input = await read(request); const device = inventory.list().find(item => item.discoveryId === input.deviceId && item.adapter === 'hue_bridge'); if (!device) return send(response, 404, { error: 'Discovered Hue Bridge not found' }); return send(response, 200, await pairHue(device, inventory)); }
    if (request.method === 'POST' && url.pathname === '/execute') { const input = await read(request); const device = inventory.list().find(item => item.discoveryId === input.deviceId); if (!device) return send(response, 404, { error: 'Discovered device not found' }); if (!input.action?.capability) return send(response, 400, { error: 'action.capability is required' }); return send(response, 200, await executeLocal(device, input.action, inventory)); }
    return send(response, 404, { error: 'Not found' });
  } catch (error) { return send(response, 400, { error: error.message }); }
}).listen(port, host, () => console.log(`Nexus local agent listening on http://${host}:${port}`));
