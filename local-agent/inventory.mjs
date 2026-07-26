import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export class LocalInventory {
  constructor(path, secret) { this.path = path; this.key = createHash('sha256').update(secret).digest(); this.state = { devices: {}, credentials: {} }; this.load(); }
  load() { if (existsSync(this.path)) this.state = JSON.parse(readFileSync(this.path, 'utf8')); }
  save() { writeFileSync(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 }); }
  merge(devices) { for (const device of devices) { const previous = this.state.devices[device.discoveryId] || {}; this.state.devices[device.discoveryId] = { ...previous, ...device, firstSeenAt: previous.firstSeenAt || device.observedAt, status: 'online' }; } this.save(); return this.list(); }
  list() { return Object.values(this.state.devices); }
  markStatus(deviceId, status) { if (this.state.devices[deviceId]) { this.state.devices[deviceId].status = status; this.state.devices[deviceId].statusChangedAt = new Date().toISOString(); this.save(); } }
  credential(adapter, deviceId) { const envelope = this.state.credentials[`${adapter}:${deviceId}`]; return envelope ? this.decrypt(envelope) : null; }
  storeCredential(adapter, deviceId, value) { this.state.credentials[`${adapter}:${deviceId}`] = this.encrypt(value); this.save(); }
  encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`; }
  decrypt(value) { const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64')); const cipher = createDecipheriv('aes-256-gcm', this.key, iv); cipher.setAuthTag(tag); return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString()); }
}
