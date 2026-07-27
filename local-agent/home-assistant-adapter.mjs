const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'homeassistant.local']);

function assertLocalController(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const privateIpv4 = /^(10\.|127\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!LOCAL_HOSTS.has(host) && !privateIpv4) throw new Error('Local Home Assistant must use a loopback, .local, or private IPv4 address');
  return url;
}

function entityCapabilities(entity) {
  const domain = entity.entity_id.split('.')[0];
  if (domain === 'light') return ['light.turn_on', 'light.turn_off', ...(entity.attributes.brightness !== undefined ? ['light.set_brightness'] : []), ...(entity.attributes.color_temp_kelvin !== undefined || entity.attributes.min_color_temp_kelvin !== undefined ? ['light.set_temperature'] : [])];
  if (domain === 'media_player') return ['speaker.play', 'speaker.pause', 'speaker.set_volume'];
  if (domain === 'climate') return ['thermostat.set_temperature'];
  return [];
}

function normalizeEntity(entity, baseUrl) {
  const capabilities = entityCapabilities(entity);
  if (!capabilities.length) return null;
  return { discoveryId: `ha:${entity.entity_id}`, providerDeviceId: entity.entity_id, controllerId: 'home_assistant_local', hostname: entity.attributes.friendly_name || entity.entity_id, room: entity.attributes.room || 'Unassigned', protocol: 'home_assistant_local', serviceType: entity.entity_id.split('.')[0], adapter: 'home_assistant_local', executable: true, capabilities, address: new URL(baseUrl).hostname, reportedState: { state: entity.state, ...entity.attributes }, observedAt: entity.last_updated || new Date().toISOString() };
}

export function createHomeAssistantLocalAdapter({ baseUrl, token, fetchImpl = fetch }) {
  const root = assertLocalController(baseUrl);
  const call = async (path, options = {}) => {
    const response = await fetchImpl(new URL(path, root), { ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Local Home Assistant rejected the request (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
  const state = device => call(`/api/states/${encodeURIComponent(device.providerDeviceId)}`);
  return {
    id: 'home_assistant_local', name: 'Home Assistant local controller', match: device => device.protocol === 'home_assistant_local',
    capabilities: ['light.turn_on', 'light.turn_off', 'light.set_brightness', 'light.set_temperature', 'speaker.play', 'speaker.pause', 'speaker.set_volume', 'thermostat.set_temperature'],
    discover: async () => (await call('/api/states')).map(entity => normalizeEntity(entity, root)).filter(Boolean),
    execute: async (device, action) => {
      const entityId = device.providerDeviceId;
      const domain = entityId.split('.')[0];
      let service; const data = { entity_id: entityId };
      if (action.capability === 'light.turn_on') service = 'turn_on';
      else if (action.capability === 'light.turn_off') service = 'turn_off';
      else if (action.capability === 'light.set_brightness') { service = 'turn_on'; data.brightness_pct = action.parameters.percent; }
      else if (action.capability === 'light.set_temperature') { service = 'turn_on'; data.color_temp_kelvin = action.parameters.kelvin; }
      else if (action.capability === 'speaker.play') service = 'media_play';
      else if (action.capability === 'speaker.pause') service = 'media_pause';
      else if (action.capability === 'speaker.set_volume') { service = 'volume_set'; data.volume_level = action.parameters.percent / 100; }
      else if (action.capability === 'thermostat.set_temperature') { service = 'set_temperature'; data.temperature = action.parameters.temperature; }
      else throw new Error(`Unsupported local Home Assistant capability: ${action.capability}`);
      await call(`/api/services/${domain}/${service}`, { method: 'POST', body: JSON.stringify(data) });
      return { acknowledged: true, adapter: 'home_assistant_local', entityId };
    },
    verify: async (device, action) => {
      const reported = await state(device); const attributes = reported.attributes || {};
      const confirmed = action.capability === 'light.turn_on' ? reported.state === 'on' : action.capability === 'light.turn_off' ? reported.state === 'off' : action.capability === 'light.set_brightness' ? Math.abs((attributes.brightness || 0) / 2.55 - action.parameters.percent) <= 2 : action.capability === 'light.set_temperature' ? Math.abs((attributes.color_temp_kelvin || 0) - action.parameters.kelvin) <= 25 : action.capability === 'speaker.play' ? reported.state === 'playing' : action.capability === 'speaker.pause' ? reported.state === 'paused' : action.capability === 'speaker.set_volume' ? Math.abs((attributes.volume_level || 0) * 100 - action.parameters.percent) <= 1 : action.capability === 'thermostat.set_temperature' ? Math.abs((attributes.temperature || 0) - action.parameters.temperature) <= 0.5 : false;
      return { confirmed, reportedState: { state: reported.state, ...attributes } };
    }
  };
}

export function configuredHomeAssistantLocalAdapter(env = process.env) {
  if (!env.LOCAL_HOME_ASSISTANT_URL || !env.LOCAL_HOME_ASSISTANT_TOKEN) return null;
  return createHomeAssistantLocalAdapter({ baseUrl: env.LOCAL_HOME_ASSISTANT_URL, token: env.LOCAL_HOME_ASSISTANT_TOKEN });
}
