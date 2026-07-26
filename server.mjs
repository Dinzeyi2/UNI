/**
 * Nexus local control-plane server.
 * Provider credentials are deliberately read only from environment variables;
 * the browser never receives them.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const key = createHash('sha256').update(process.env.NEXUS_TOKEN_KEY || 'development-key-change-me').digest();
const providers = {
  smartthings: { name: 'SmartThings', authorizationUrl: 'https://api.smartthings.com/oauth/authorize', scopes: ['r:devices:*', 'x:devices:*'], configured: Boolean(process.env.SMARTTHINGS_CLIENT_ID && process.env.SMARTTHINGS_CLIENT_SECRET), availability: 'available', consent: 'OAuth — you approve device read, status, and control access with Samsung.' },
  home_assistant: { name: 'Home Assistant', authorizationUrl: null, scopes: ['read', 'control'], configured: Boolean(process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN), availability: 'available', consent: 'Your server token stays encrypted on Nexus; it is never sent to the browser.' },
  google_home: { name: 'Google Home', authorizationUrl: null, scopes: [], configured: false, availability: 'planned', consent: 'Production access requires Google’s applicable OAuth verification and approvals.' },
  tuya: { name: 'Tuya', authorizationUrl: null, scopes: [], configured: false, availability: 'planned', consent: 'A Tuya cloud project and account authorization are required.' },
  matter: { name: 'Matter', authorizationUrl: null, scopes: [], configured: false, availability: 'planned', consent: 'Matter support will use a local fabric/controller connection, not cloud OAuth.' }
};
const connections = new Map();
const normalizedDevices = new Map();
const approvals = new Map();
const behaviors = new Map();
const auditEvents = [];
const capabilities = new Set(['light.turn_on', 'light.turn_off', 'light.set_brightness', 'light.set_temperature', 'speaker.play', 'speaker.pause', 'speaker.set_volume', 'thermostat.set_temperature', 'sensor.motion_detected']);
const stateFile = join(root, '.nexus-state.json');
function restoreState() { if (!existsSync(stateFile)) return; try { const saved = JSON.parse(readFileSync(stateFile, 'utf8')); for (const [key, value] of saved.connections || []) connections.set(key, value); for (const [key, value] of saved.devices || []) normalizedDevices.set(key, value); for (const [key, value] of saved.behaviors || []) behaviors.set(key, value); for (const [key, value] of saved.approvals || []) approvals.set(key, value); auditEvents.push(...(saved.auditEvents || [])); } catch { /* start empty if a local development state file is malformed */ } }
function saveState() { writeFileSync(stateFile, JSON.stringify({ connections: [...connections], devices: [...normalizedDevices], behaviors: [...behaviors], approvals: [...approvals], auditEvents: auditEvents.slice(0, 500) }), { mode: 0o600 }); }
function audit(userId, type, detail) { auditEvents.unshift({ eventId: `evt_${randomBytes(8).toString('hex')}`, userId, type, detail, at: new Date().toISOString() }); auditEvents.splice(500); saveState(); }
restoreState();

function send(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(payload)); }
function encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`; }
function decrypt(value) { const [iv, tag, body] = value.split('.').map(x => Buffer.from(x, 'base64')); const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'); }
function body(request) { return new Promise((resolve, reject) => { let raw = ''; request.on('data', part => { raw += part; if (raw.length > 1_000_000) reject(new Error('Request too large')); }); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } }); }); }
function userId(request) { return request.headers['x-nexus-user-id'] || 'demo-user'; }
function actionRisk(capability) { if (/lock\.unlock|alarm|garage|camera/.test(capability)) return 'high'; if (/lock\.lock|thermostat|appliance/.test(capability)) return 'medium'; return 'low'; }
function policy(actions) { return actions.map(action => ({ ...action, risk: actionRisk(action.capability), allowed: actionRisk(action.capability) === 'low', reason: actionRisk(action.capability) === 'low' ? 'Low-risk capability' : 'Explicit confirmation is required' })); }
function actionHash(actions) { return createHash('sha256').update(JSON.stringify(actions)).digest('hex'); }
function devicesFor(user) { return [...normalizedDevices.values()].filter(device => device.userId === user); }
function firstDevice(user, capability, matcher = () => true) { return devicesFor(user).find(device => device.capabilities.includes(capability) && matcher(device)); }
function compileBehavior(user, input) {
  const intent = String(input.intent || '').trim(); if (!intent) throw new Error('intent is required'); const lower = intent.toLowerCase(); const light = firstDevice(user, 'light.set_brightness'); const speaker = firstDevice(user, 'speaker.play') || firstDevice(user, 'speaker.pause'); const motion = firstDevice(user, 'sensor.motion_detected'); const thermostat = firstDevice(user, 'thermostat.set_temperature');
  const isNight = /sleep|night|arrival|arrive|bed|wind down/.test(lower); const isFocus = /focus|work|meeting/.test(lower); const isAway = /away|leave|leaving|vacation/.test(lower); const actions = [];
  if (isAway) {
    const switchableLight = firstDevice(user, 'light.turn_off');
    if (switchableLight) actions.push({ deviceId: switchableLight.deviceId, capability: 'light.turn_off', parameters: {}, reason: 'Avoid leaving lights on while the home is away' });
    if (speaker) actions.push({ deviceId: speaker.deviceId, capability: 'speaker.pause', parameters: {}, reason: 'Pause media before the home is empty' });
  } else if (light) actions.push({ deviceId: light.deviceId, capability: 'light.set_brightness', parameters: { percent: isNight ? 10 : 70 }, reason: isNight ? 'Keep lighting low at night' : 'Create a focused workspace' });
  if (isFocus && speaker) actions.push({ deviceId: speaker.deviceId, capability: 'speaker.play', parameters: { content: 'focus_playlist' }, reason: 'Provide optional focus audio' });
  if (isNight && thermostat) actions.push({ deviceId: thermostat.deviceId, capability: 'thermostat.set_temperature', parameters: { temperature: 20 }, reason: 'Set nighttime comfort temperature' });
  const behavior = { behaviorId: `beh_${randomBytes(12).toString('hex')}`, name: input.name || (isAway ? 'Away Mode' : isNight ? 'Night Navigation' : isFocus ? 'Deep Focus' : 'Custom Environment'), goal: intent, status: 'draft', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), triggers: motion && isNight ? [{ type: 'sensor.motion_detected', deviceId: motion.deviceId }] : [{ type: 'manual.start' }], conditions: isAway ? [{ type: 'presence.home', value: false }] : isNight ? [{ type: 'time.between', start: '23:00', end: '06:00' }] : [{ type: 'presence.home', value: true }], actions, safeguards: [{ rule: 'preserve_manual_override' }, { rule: 'never_unlock_doors' }, { rule: 'no_protected_action_without_explicit_confirmation' }], termination: [{ type: 'timeout', afterMinutes: isNight ? 10 : 120 }], requiredCapabilities: [...new Set(actions.map(action => action.capability))], versions: [] };
  behavior.versions.push({ version: 1, createdAt: behavior.createdAt, specification: structuredClone({ ...behavior, versions: undefined }) }); return behavior;
}
function behaviorSimulation(user, behavior) { const reviewed = policy(behavior.actions).map(action => ({ ...action, grounded: Boolean(normalizedDevices.get(`${user}:${action.deviceId}`)?.capabilities.includes(action.capability)) })); return { behaviorId: behavior.behaviorId, simulation: { triggered: true, conditionsMet: reviewed.every(action => action.grounded), actions: reviewed, blocked: reviewed.filter(action => !action.grounded || action.risk !== 'low'), outcome: reviewed.every(action => action.grounded) ? 'ready_for_approval' : 'missing_capabilities' } }; }
async function runBehavior(user, behavior, event) { if (behavior.status !== 'deployed') return; const trigger = behavior.triggers.some(item => item.type === event.type && (!item.deviceId || item.deviceId === event.deviceId)); if (!trigger) return; const simulation = behaviorSimulation(user, behavior); if (simulation.simulation.blocked.length) return audit(user, 'behavior.blocked', { behaviorId: behavior.behaviorId, event, blocked: simulation.simulation.blocked }); behavior.lastRunAt = new Date().toISOString(); behavior.runCount = (behavior.runCount || 0) + 1; saveState(); audit(user, 'behavior.triggered', { behaviorId: behavior.behaviorId, event }); }
function connectionFor(user, provider) { const connection = connections.get(`${user}:${provider}`); if (!connection) throw new Error(`No ${provider} connection for this user`); return { ...connection, accessToken: decrypt(connection.accessTokenEncrypted) }; }
async function providerFetch(url, options = {}) { const response = await fetch(url, options); if (!response.ok) throw new Error(`Provider request failed (${response.status}): ${await response.text()}`); return response.status === 204 ? null : response.json(); }
function homeAssistantDevices(states) {
  return states.map(state => {
    const [domain] = state.entity_id.split('.'); const attributes = state.attributes || {}; const type = domain === 'light' ? 'light' : domain === 'media_player' ? 'speaker' : domain === 'climate' ? 'thermostat' : domain === 'binary_sensor' ? 'sensor' : domain;
    const capabilitiesByDomain = { light: ['light.turn_on', 'light.turn_off', 'light.set_brightness', 'light.set_temperature'], media_player: ['speaker.play', 'speaker.pause', 'speaker.set_volume'], climate: ['thermostat.set_temperature'], binary_sensor: ['sensor.motion_detected'] };
    return { deviceId: state.entity_id, provider: 'home_assistant', name: attributes.friendly_name || state.entity_id, room: attributes.area_name || 'Unassigned', type, online: state.state !== 'unavailable', capabilities: capabilitiesByDomain[domain] || [], reportedState: { state: state.state, ...attributes }, observedAt: state.last_updated };
  }).filter(device => device.capabilities.length);
}
function smartThingsDevices(devices, statuses) {
  const mappings = { 'switch': ['light.turn_on', 'light.turn_off'], 'switchLevel': ['light.set_brightness'], 'colorTemperature': ['light.set_temperature'], 'audioVolume': ['speaker.set_volume'], 'mediaPlayback': ['speaker.play', 'speaker.pause'], 'thermostatCoolingSetpoint': ['thermostat.set_temperature'], 'thermostatHeatingSetpoint': ['thermostat.set_temperature'], 'motionSensor': ['sensor.motion_detected'] };
  return devices.items.map(device => { const status = statuses.get(device.deviceId) || {}; const caps = Object.keys(status.components?.main || {}).flatMap(capability => mappings[capability] || []); return { deviceId: device.deviceId, provider: 'smartthings', name: device.label || device.name, room: device.roomId || 'Unassigned', type: device.type || 'device', online: device.status !== 'OFFLINE', capabilities: [...new Set(caps)], reportedState: status, observedAt: new Date().toISOString() }; }).filter(device => device.capabilities.length);
}
async function syncProvider(user, provider) {
  const connection = connectionFor(user, provider);
  let devices;
  if (provider === 'home_assistant') {
    const states = await providerFetch(`${connection.baseUrl}/api/states`, { headers: { authorization: `Bearer ${connection.accessToken}` } }); devices = homeAssistantDevices(states);
  } else if (provider === 'smartthings') {
    const listed = await providerFetch('https://api.smartthings.com/v1/devices', { headers: { authorization: `Bearer ${connection.accessToken}` } }); const statuses = new Map(await Promise.all(listed.items.map(async d => [d.deviceId, await providerFetch(`https://api.smartthings.com/v1/devices/${d.deviceId}/components/main/status`, { headers: { authorization: `Bearer ${connection.accessToken}` } })]))); devices = smartThingsDevices(listed, statuses);
  } else throw new Error('Unsupported provider');
  devices.forEach(device => normalizedDevices.set(`${user}:${device.deviceId}`, { ...device, userId: user })); return devices;
}
function homeAssistantCommand(action) { const [domain] = action.deviceId.split('.'); const service = action.capability === 'light.turn_off' ? 'turn_off' : action.capability === 'speaker.pause' ? 'media_pause' : action.capability === 'speaker.play' ? 'media_play' : 'turn_on'; const data = { entity_id: action.deviceId }; if (action.capability === 'light.set_brightness') data.brightness_pct = action.parameters?.percent; if (action.capability === 'light.set_temperature') data.color_temp_kelvin = action.parameters?.kelvin; if (action.capability === 'speaker.set_volume') data.volume_level = action.parameters?.percent / 100; if (action.capability === 'thermostat.set_temperature') data.temperature = action.parameters?.temperature; return { domain, service, data }; }
async function executeProviderAction(user, action) {
  const device = normalizedDevices.get(`${user}:${action.deviceId}`); if (!device || !device.capabilities.includes(action.capability)) throw new Error('Action is not grounded in this user’s current capability graph'); const connection = connectionFor(user, device.provider);
  if (device.provider === 'home_assistant') { const command = homeAssistantCommand(action); await providerFetch(`${connection.baseUrl}/api/services/${command.domain}/${command.service}`, { method: 'POST', headers: { authorization: `Bearer ${connection.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(command.data) }); return { deviceId: device.deviceId, capability: action.capability, provider: device.provider, acknowledged: true }; }
  if (device.provider === 'smartthings') { const commandMap = { 'light.turn_on': ['switch', 'on', []], 'light.turn_off': ['switch', 'off', []], 'light.set_brightness': ['switchLevel', 'setLevel', [action.parameters?.percent]], 'light.set_temperature': ['colorTemperature', 'setColorTemperature', [action.parameters?.kelvin]] }; const command = commandMap[action.capability]; if (!command) throw new Error('This SmartThings capability translation has not been implemented'); await providerFetch(`https://api.smartthings.com/v1/devices/${device.deviceId}/commands`, { method: 'POST', headers: { authorization: `Bearer ${connection.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ commands: [{ component: 'main', capability: command[0], command: command[1], arguments: command[2] }] }) }); return { deviceId: device.deviceId, capability: action.capability, provider: device.provider, acknowledged: true }; }
  throw new Error('Unsupported provider');
}

async function api(request, response, url) {
  const user = userId(request);
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { status: 'ok', providers: Object.keys(providers) });
  if (request.method === 'GET' && url.pathname === '/api/providers') return send(response, 200, Object.entries(providers).map(([id, provider]) => ({ id, ...provider, connected: connections.has(`${user}:${id}`) })));
  if (request.method === 'POST' && url.pathname.startsWith('/api/connect/')) {
    const id = url.pathname.split('/').pop(); const provider = providers[id]; if (!provider) return send(response, 404, { error: 'Unknown provider' });
    if (provider.availability !== 'available') return send(response, 409, { error: `${provider.name} is planned but is not available to connect yet.` });
    if (!provider.configured) return send(response, 409, { error: `${provider.name} is not configured on this server. Add its credentials to the server environment first.` });
    if (id === 'home_assistant') { connections.set(`${user}:${id}`, { provider: id, baseUrl: process.env.HOME_ASSISTANT_URL.replace(/\/$/, ''), accessTokenEncrypted: encrypt(process.env.HOME_ASSISTANT_TOKEN), connectedAt: new Date().toISOString() }); saveState(); audit(user, 'provider.connected', { provider: id }); return send(response, 201, { status: 'connected', provider: id }); }
    const state = encrypt(JSON.stringify({ user, provider: id, expiresAt: Date.now() + 600_000 }));
    const params = new URLSearchParams({ client_id: process.env.SMARTTHINGS_CLIENT_ID, response_type: 'code', redirect_uri: `${process.env.NEXUS_BASE_URL || `http://localhost:${port}`}/api/oauth/smartthings/callback`, scope: provider.scopes.join(' '), state });
    return send(response, 200, { authorizationUrl: `${provider.authorizationUrl}?${params}` });
  }
  if (request.method === 'GET' && url.pathname === '/api/oauth/smartthings/callback') {
    if (!url.searchParams.get('code') || !url.searchParams.get('state')) return send(response, 400, { error: 'Missing OAuth code or state' }); const state = JSON.parse(decrypt(url.searchParams.get('state'))); if (state.provider !== 'smartthings' || state.expiresAt < Date.now()) return send(response, 400, { error: 'Invalid or expired OAuth state' });
    const token = await providerFetch('https://api.smartthings.com/oauth/token', { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: `${process.env.NEXUS_BASE_URL || `http://localhost:${port}`}/api/oauth/smartthings/callback` }) }); connections.set(`${state.user}:smartthings`, { provider: 'smartthings', accessTokenEncrypted: encrypt(token.access_token), refreshTokenEncrypted: token.refresh_token ? encrypt(token.refresh_token) : null, expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null, connectedAt: new Date().toISOString() }); saveState(); audit(state.user, 'provider.connected', { provider: 'smartthings' }); response.writeHead(302, { location: '/' }); return response.end();
  }
  if (request.method === 'GET' && url.pathname === '/api/devices') return send(response, 200, [...normalizedDevices.values()].filter(d => d.userId === user));
  if (request.method === 'POST' && url.pathname === '/api/devices/import') {
    const input = await body(request); if (!input.provider || !Array.isArray(input.devices)) return send(response, 400, { error: 'provider and devices[] are required' });
    const imported = input.devices.map(raw => ({ deviceId: raw.deviceId, userId: user, provider: input.provider, name: raw.name, room: raw.room || 'Unassigned', type: raw.type, online: raw.online !== false, capabilities: raw.capabilities.filter(c => capabilities.has(c)), reportedState: raw.reportedState || {}, observedAt: new Date().toISOString() }));
    imported.forEach(device => normalizedDevices.set(`${user}:${device.deviceId}`, device)); saveState(); audit(user, 'devices.imported', { provider: input.provider, count: imported.length }); return send(response, 201, { imported: imported.length, devices: imported });
  }
  if (request.method === 'GET' && url.pathname === '/api/behaviors') return send(response, 200, [...behaviors.values()].filter(behavior => behavior.userId === user));
  if (request.method === 'GET' && url.pathname === '/api/audit-events') return send(response, 200, auditEvents.filter(event => event.userId === user));
  if (request.method === 'POST' && url.pathname === '/api/behaviors') { const behavior = compileBehavior(user, await body(request)); behavior.userId = user; behaviors.set(behavior.behaviorId, behavior); saveState(); audit(user, 'behavior.created', { behaviorId: behavior.behaviorId, version: 1 }); return send(response, 201, behavior); }
  if (request.method === 'POST' && url.pathname.match(/^\/api\/behaviors\/[^/]+\/simulate$/)) { const id = url.pathname.split('/')[3]; const behavior = behaviors.get(id); if (!behavior || behavior.userId !== user) return send(response, 404, { error: 'Behavior not found' }); return send(response, 200, behaviorSimulation(user, behavior)); }
  if (request.method === 'POST' && url.pathname.match(/^\/api\/behaviors\/[^/]+\/deploy$/)) { const id = url.pathname.split('/')[3]; const behavior = behaviors.get(id); if (!behavior || behavior.userId !== user) return send(response, 404, { error: 'Behavior not found' }); const simulation = behaviorSimulation(user, behavior); if (simulation.simulation.blocked.length) return send(response, 409, simulation); behavior.status = 'deployed'; behavior.deployedAt = new Date().toISOString(); saveState(); audit(user, 'behavior.deployed', { behaviorId: id }); return send(response, 200, behavior); }
  if (request.method === 'PATCH' && url.pathname.match(/^\/api\/behaviors\/[^/]+$/)) { const id = url.pathname.split('/').pop(); const behavior = behaviors.get(id); if (!behavior || behavior.userId !== user) return send(response, 404, { error: 'Behavior not found' }); const patch = await body(request); const next = { ...behavior, ...patch, behaviorId: behavior.behaviorId, userId: user, version: behavior.version + 1, status: 'draft', updatedAt: new Date().toISOString() }; next.versions = [...behavior.versions, { version: next.version, createdAt: next.updatedAt, specification: structuredClone({ ...next, versions: undefined }) }]; behaviors.set(id, next); saveState(); audit(user, 'behavior.versioned', { behaviorId: id, version: next.version }); return send(response, 200, next); }
  if (request.method === 'POST' && url.pathname.startsWith('/api/sync/')) { const provider = url.pathname.split('/').pop(); const devices = await syncProvider(user, provider); saveState(); audit(user, 'devices.synced', { provider, count: devices.length }); return send(response, 200, { provider, imported: devices.length, devices }); }
  if (request.method === 'POST' && url.pathname === '/api/events') { const event = await body(request); if (!event.type) return send(response, 400, { error: 'event.type is required' }); await Promise.all([...behaviors.values()].filter(behavior => behavior.userId === user).map(behavior => runBehavior(user, behavior, event))); audit(user, 'environment.event', event); return send(response, 202, { accepted: true }); }
  if (request.method === 'POST' && url.pathname === '/api/emergency-stop') { let paused = 0; for (const behavior of behaviors.values()) if (behavior.userId === user && behavior.status === 'deployed') { behavior.status = 'paused'; paused += 1; } saveState(); audit(user, 'emergency_stop.activated', { pausedBehaviors: paused }); return send(response, 200, { pausedBehaviors: paused }); }
  if (request.method === 'POST' && url.pathname === '/api/plans/validate') {
    const input = await body(request); if (!Array.isArray(input.actions)) return send(response, 400, { error: 'actions[] is required' });
    const known = new Set([...normalizedDevices.values()].filter(d => d.userId === user).flatMap(d => d.capabilities));
    const actions = policy(input.actions).map(action => ({ ...action, grounded: known.has(action.capability), allowed: action.allowed && known.has(action.capability) }));
    return send(response, 200, { decision: actions.every(a => a.allowed) ? 'approved' : 'requires_confirmation', actions });
  }
  if (request.method === 'POST' && url.pathname === '/api/approvals') { const input = await body(request); if (!Array.isArray(input.actions) || !input.behaviorId) return send(response, 400, { error: 'behaviorId and actions[] are required' }); const reviewed = policy(input.actions); const known = new Set([...normalizedDevices.values()].filter(d => d.userId === user).flatMap(d => d.capabilities)); if (reviewed.some(action => !known.has(action.capability))) return send(response, 409, { error: 'Cannot approve actions not grounded in the current capability graph' }); const approval = { approvalId: `apr_${randomBytes(12).toString('hex')}`, userId: user, behaviorId: input.behaviorId, actionHash: actionHash(input.actions), approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), status: 'approved', executedAt: null }; approvals.set(approval.approvalId, approval); return send(response, 201, approval); }
  if (request.method === 'POST' && url.pathname === '/api/execute') { const input = await body(request); if (!Array.isArray(input.actions) || !input.approvalId) return send(response, 400, { error: 'actions[] and approvalId are required' }); const approval = approvals.get(input.approvalId); if (!approval || approval.userId !== user || approval.status !== 'approved' || approval.expiresAt < new Date().toISOString() || approval.actionHash !== actionHash(input.actions)) return send(response, 409, { error: 'Approval is missing, expired, already used, belongs to another user, or does not match this exact action list' }); const reviewed = policy(input.actions); if (reviewed.some(action => action.risk !== 'low') && input.explicitConfirmation !== true) return send(response, 409, { error: 'Medium and high-risk actions require explicitConfirmation: true', actions: reviewed }); const receipts = []; for (const action of input.actions) receipts.push(await executeProviderAction(user, action)); approval.status = 'executed'; approval.executedAt = new Date().toISOString(); return send(response, 201, { approvalId: input.approvalId, receipts }); }
  return send(response, 404, { error: 'Not found' });
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname.startsWith('/api/')) { try { return await api(request, response, url); } catch (error) { return send(response, 400, { error: error.message }); } }
  const requested = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/, ''); const file = join(root, requested);
  if (!file.startsWith(root) || !existsSync(file)) { response.writeHead(404); return response.end('Not found'); }
  response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); createReadStream(file).pipe(response);
}).listen(port, () => console.log(`Nexus local control plane listening on http://localhost:${port}`));

export { encrypt, decrypt, policy };
