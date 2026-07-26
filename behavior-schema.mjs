export const CAPABILITY_REGISTRY = {
  'light.turn_on': { risk: 'low', parameters: {} },
  'light.turn_off': { risk: 'low', parameters: {} },
  'light.set_brightness': { risk: 'low', parameters: { percent: { type: 'number', minimum: 0, maximum: 100 } } },
  'light.set_temperature': { risk: 'low', parameters: { kelvin: { type: 'number', minimum: 1000, maximum: 10000 } } },
  'speaker.play': { risk: 'low', parameters: { content: { type: 'string' } } },
  'speaker.pause': { risk: 'low', parameters: {} },
  'speaker.set_volume': { risk: 'low', parameters: { percent: { type: 'number', minimum: 0, maximum: 100 } } },
  'thermostat.set_temperature': { risk: 'medium', parameters: { temperature: { type: 'number', minimum: 10, maximum: 32 } } }
};

export function validateBehaviorSpecification(specification, devices) {
  const issues = [];
  if (!specification || typeof specification !== 'object') return { valid: false, issues: ['Behavior must be an object'] };
  if (!String(specification.name || '').trim()) issues.push('name is required');
  if (!String(specification.goal || '').trim()) issues.push('goal is required');
  if (!Array.isArray(specification.triggers) || !specification.triggers.length) issues.push('at least one trigger is required');
  if (!Array.isArray(specification.actions) || !specification.actions.length) issues.push('at least one action is required');
  const byId = new Map(devices.map(device => [device.deviceId, device]));
  for (const [index, action] of (specification.actions || []).entries()) {
    const prefix = `actions[${index}]`;
    const definition = CAPABILITY_REGISTRY[action.capability];
    const device = byId.get(action.deviceId);
    if (!definition) { issues.push(`${prefix}.capability is not registered`); continue; }
    if (!device) issues.push(`${prefix}.deviceId is not in the environment graph`);
    else if (!device.capabilities.includes(action.capability)) issues.push(`${prefix}.capability is not supported by that device`);
    for (const [name, rule] of Object.entries(definition.parameters)) {
      const value = action.parameters?.[name];
      if (rule.type === 'number' && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) issues.push(`${prefix}.parameters.${name} must be between ${rule.minimum} and ${rule.maximum}`);
      if (rule.type === 'string' && !String(value || '').trim()) issues.push(`${prefix}.parameters.${name} is required`);
    }
  }
  for (const [index, fallback] of (specification.fallbacks || []).entries()) {
    if (!Number.isInteger(fallback.forAction) || fallback.forAction < 0 || fallback.forAction >= (specification.actions || []).length) issues.push(`fallbacks[${index}].forAction is invalid`);
    const definition = CAPABILITY_REGISTRY[fallback.action?.capability]; const device = byId.get(fallback.action?.deviceId);
    if (!definition) issues.push(`fallbacks[${index}].action.capability is not registered`);
    if (!device) issues.push(`fallbacks[${index}].action.deviceId is not in the environment graph`);
    else if (definition && !device.capabilities.includes(fallback.action.capability)) issues.push(`fallbacks[${index}].action.capability is not supported by that device`);
    for (const [name, rule] of Object.entries(definition?.parameters || {})) { const value = fallback.action?.parameters?.[name]; if (rule.type === 'number' && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) issues.push(`fallbacks[${index}].action.parameters.${name} is invalid`); if (rule.type === 'string' && !String(value || '').trim()) issues.push(`fallbacks[${index}].action.parameters.${name} is required`); }
  }
  return { valid: !issues.length, issues };
}

export const behaviorJsonSchema = {
  name: 'nexus_behavior', strict: true, schema: {
    type: 'object', additionalProperties: false, required: ['name', 'goal', 'triggers', 'conditions', 'actions', 'fallbacks', 'safeguards', 'termination'],
    properties: {
      name: { type: 'string' }, goal: { type: 'string' },
      triggers: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['type', 'deviceId', 'event'], properties: { type: { type: 'string' }, deviceId: { type: ['string', 'null'] }, event: { type: ['string', 'null'] } } } },
      conditions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'start', 'end', 'value'], properties: { type: { type: 'string' }, start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] }, value: {} } } },
      actions: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['deviceId', 'capability', 'parameters', 'reason'], properties: { deviceId: { type: 'string' }, capability: { type: 'string', enum: Object.keys(CAPABILITY_REGISTRY) }, parameters: { type: 'object', additionalProperties: true }, reason: { type: 'string' } } } },
      fallbacks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['forAction', 'when', 'action'], properties: { forAction: { type: 'integer' }, when: { type: 'string', enum: ['offline', 'timeout', 'unconfirmed'] }, action: { type: 'object', additionalProperties: false, required: ['deviceId', 'capability', 'parameters', 'reason'], properties: { deviceId: { type: 'string' }, capability: { type: 'string', enum: Object.keys(CAPABILITY_REGISTRY) }, parameters: { type: 'object', additionalProperties: true }, reason: { type: 'string' } } } } } },
      safeguards: { type: 'array', items: { type: 'string' } }, termination: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'afterMinutes'], properties: { type: { type: 'string' }, afterMinutes: { type: ['number', 'null'] } } } }
    }
  }
};
