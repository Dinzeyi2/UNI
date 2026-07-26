import dgram from 'node:dgram';
import os from 'node:os';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2', 'ST: ssdp:all', '', ''].join('\r\n'));

function dnsName(value) { return Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]); }
function readDnsName(packet, start, seen = new Set()) { let offset = start; const labels = []; let consumed = 0; while (offset < packet.length) { const length = packet[offset]; if ((length & 0xc0) === 0xc0) { const pointer = ((length & 0x3f) << 8) | packet[offset + 1]; if (seen.has(pointer)) break; seen.add(pointer); labels.push(readDnsName(packet, pointer, seen).name); consumed += 2; return { name: labels.filter(Boolean).join('.'), bytes: consumed }; } if (length === 0) { consumed += 1; break; } labels.push(packet.subarray(offset + 1, offset + 1 + length).toString()); offset += length + 1; consumed += length + 1; } return { name: labels.join('.'), bytes: consumed }; }
const MDNS_QUERY = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), dnsName('_services._dns-sd._udp.local'), Buffer.from([0, 12, 0, 1])]);

export function parseMdnsMessage(packet, remote = {}) {
  if (packet.length < 12) return [];
  const questions = packet.readUInt16BE(4); const answers = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10); let offset = 12;
  for (let index = 0; index < questions; index += 1) { const name = readDnsName(packet, offset); offset += name.bytes + 4; }
  const devices = [];
  for (let index = 0; index < answers && offset + 10 <= packet.length; index += 1) { const owner = readDnsName(packet, offset); offset += owner.bytes; const type = packet.readUInt16BE(offset); const length = packet.readUInt16BE(offset + 8); offset += 10; if (offset + length > packet.length) break; if (type === 12) { const target = readDnsName(packet, offset).name; const device = { discoveryId: `mdns:${target}`, address: remote.address || null, hostname: target, protocol: 'mdns', serviceType: target, location: null, server: null, observedAt: new Date().toISOString(), raw: { owner: owner.name, target } }; devices.push({ ...device, ...classifyDevice(device) }); } offset += length; }
  return devices;
}

export function parseSsdpMessage(raw, remote = {}) {
  const lines = String(raw).split(/\r?\n/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  if (!headers.usn && !headers.location) return null;
  return {
    discoveryId: headers.usn || headers.location,
    address: remote.address || null,
    hostname: null,
    protocol: 'ssdp',
    serviceType: headers.st || headers.nt || 'unknown',
    location: headers.location || null,
    server: headers.server || null,
    observedAt: new Date().toISOString(),
    raw: headers
  };
}

export function classifyDevice(device) {
  const signature = `${device.serviceType || ''} ${device.server || ''} ${device.location || ''}`.toLowerCase();
  if (/hue|philips|ipbridge/.test(signature)) return { tier: 'secure_pairing', adapter: 'hue_bridge', reason: 'Press the Hue Bridge link button to authorize local control.' };
  if (/shelly/.test(signature)) return { tier: 'secure_pairing', adapter: 'shelly', reason: 'Local control is supported after device authentication when enabled.' };
  if (/sonos|zoneplayer/.test(signature)) return { tier: 'local_standard', adapter: 'sonos', reason: 'A supported local Sonos adapter can control this device.' };
  if (/matter|_matter/.test(signature)) return { tier: 'secure_pairing', adapter: 'matter', reason: 'Matter commissioning is required before local control.' };
  if (/homekit|hap\b/.test(signature)) return { tier: 'secure_pairing', adapter: 'homekit', reason: 'HomeKit secure pairing is required before local control.' };
  if (/upnp|mediarenderer|dial/.test(signature)) return { tier: 'local_standard', adapter: 'upnp', reason: 'Discovered locally; control depends on the advertised UPnP services.' };
  return { tier: 'locked_or_unknown', adapter: null, reason: 'The device is visible, but Nexus has no authorized local control adapter for it.' };
}

export function localIpv4Networks() {
  return Object.values(os.networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal).map(address => ({ address: address.address, netmask: address.netmask, interface: address.scopeid || null }));
}

export async function discoverSsdp({ timeoutMs = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const devices = new Map();
    const finish = () => { socket.close(); resolve([...devices.values()].map(device => ({ ...device, ...classifyDevice(device) }))); };
    socket.on('error', error => { socket.close(); reject(error); });
    socket.on('message', (message, remote) => { const device = parseSsdpMessage(message, remote); if (device) devices.set(device.discoveryId, device); });
    socket.bind(0, () => { socket.setBroadcast(true); socket.send(SEARCH, SSDP_PORT, SSDP_ADDRESS); setTimeout(finish, timeoutMs); });
  });
}

export async function discoverMdns({ timeoutMs = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }); const devices = new Map();
    const finish = () => { socket.close(); resolve([...devices.values()]); };
    socket.on('error', error => { socket.close(); reject(error); });
    socket.on('message', (message, remote) => { for (const device of parseMdnsMessage(message, remote)) devices.set(device.discoveryId, device); });
    socket.bind(0, () => { socket.send(MDNS_QUERY, 5353, '224.0.0.251'); setTimeout(finish, timeoutMs); });
  });
}

export async function discoverLocal(options = {}) { const [ssdp, mdns] = await Promise.all([discoverSsdp(options), discoverMdns(options)]); return [...new Map([...ssdp, ...mdns].map(device => [device.discoveryId, device])).values()]; }
