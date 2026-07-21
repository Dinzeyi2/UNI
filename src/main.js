const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Nexus could not complete that request');
  return data;
};

let devices = [];
let behaviors = [];
let candidate = null;
const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3200); };
const risk = (capability) => /thermostat|lock|alarm|garage|camera/.test(capability) ? 'medium' : 'low';
const actionText = (action) => `${action.capability} · ${Object.entries(action.parameters || {}).map(([key, value]) => `${key}: ${value}`).join(', ') || 'default'}`;

function behaviorCard(behavior, wide = false) {
  const status = behavior.status === 'deployed' ? '● Deployed' : '◌ Draft';
  const chips = behavior.actions.slice(0, 2).map(action => `<span>${actionText(action)}</span>`).join('') || '<span>No compatible actions found</span>';
  return `<article class="behavior-card ${wide ? 'wide' : ''}"><div class="card-top"><i class="card-icon">✦</i><span class="status ${behavior.status}">${status}</span></div><h3>${behavior.name}</h3><p>${behavior.goal}</p><div class="chips">${chips}</div><div class="card-footer"><small>Version ${behavior.version} · ${behavior.actions.length} actions</small><button class="outline review" data-id="${behavior.behaviorId}">Review</button></div></article>`;
}
function renderBehaviors() { $('#behavior-count').textContent = behaviors.length; $('#behavior-cards').innerHTML = behaviors.slice(0, 3).map(behavior => behaviorCard(behavior)).join('') || '<div class="empty">Describe your first environment behavior.</div>'; $('#behavior-library').innerHTML = behaviors.map(behavior => behaviorCard(behavior, true)).join('') || '<div class="empty">No behaviors yet.</div>'; }
function renderDevices() { $('#device-list').innerHTML = devices.map(device => `<article class="device"><div><i>◌</i><span><p class="label">${device.room.toUpperCase()} · ${device.type.toUpperCase()}</p><h3>${device.name}</h3></span><b>${device.online ? 'Online' : 'Offline'}</b></div><section>${device.capabilities.map(capability => `<span>${capability}</span>`).join('')}</section></article>`).join('') || '<div class="empty">Connect a provider and synchronize devices to build your capability graph.</div>'; }
function renderActivity(events) { const markup = events.map(event => `<div class="activity"><i class="activity-icon system">⌁</i><div><strong>${event.type}</strong><p>${JSON.stringify(event.detail)}</p></div><time>${new Date(event.at).toLocaleTimeString()}</time></div>`).join('') || '<div class="empty">No runtime activity yet.</div>'; $('#activity-list').innerHTML = markup.slice(0, 2000); $('#full-activity-list').innerHTML = markup; }
async function refresh() { [devices, behaviors] = await Promise.all([api('/devices'), api('/behaviors')]); renderDevices(); renderBehaviors(); renderActivity(await api('/audit-events')); }
function planAction(action) { const device = devices.find(item => item.deviceId === action.deviceId); return `<div class="plan-action"><i>${risk(action.capability) === 'low' ? '✓' : '!'}</i><span><strong>${device?.name || action.deviceId}</strong><small>${actionText(action)}</small></span><b class="risk ${risk(action.capability)}">${risk(action.capability)} risk</b></div>`; }
async function review(behavior) { candidate = behavior; const simulation = await api(`/behaviors/${behavior.behaviorId}/simulate`, { method: 'POST' }); $('#plan-title').textContent = behavior.name; $('#plan-summary').textContent = behavior.goal; $('#plan-context').innerHTML = `<strong>Generated behavior</strong><span>${behavior.triggers.length} trigger(s)</span><span>${behavior.conditions.length} condition(s)</span><span>${behavior.termination[0]?.afterMinutes || 0} minute timeout</span>`; $('#plan-actions').innerHTML = behavior.actions.map(planAction).join('') || '<p class="muted">No compatible devices are currently available. Connect and sync an ecosystem first.</p>'; $('#plan-policy').innerHTML = simulation.simulation.blocked.length ? `<div class="policy caution"><strong>Cannot deploy yet</strong><span>${simulation.simulation.blocked.length} action(s) require changes or explicit handling.</span></div>` : `<div class="policy good"><strong>Simulation passed</strong><span>Every action is grounded in your current capability graph.</span></div>`; $('#approve-plan').disabled = Boolean(simulation.simulation.blocked.length); $('#approve-plan').textContent = behavior.status === 'deployed' ? 'Deployed' : 'Deploy behavior →'; $('#plan-dialog').showModal(); }
function page(name) { document.querySelectorAll('.page').forEach(item => item.classList.add('hidden')); $(`#${name}-page`).classList.remove('hidden'); document.querySelectorAll('.nav').forEach(item => item.classList.toggle('active', item.dataset.page === name)); }

$('#intent-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('#intent-input'); try { const behavior = await api('/behaviors', { method: 'POST', body: JSON.stringify({ intent: input.value }) }); input.value = ''; await refresh(); await review(behavior); } catch (error) { toast(error.message); } });
document.addEventListener('click', async (event) => { const button = event.target.closest('button'); if (!button) return; if (button.dataset.intent) { $('#intent-input').value = button.dataset.intent; $('#intent-input').focus(); } if (button.dataset.page) page(button.dataset.page); if (button.classList.contains('review')) { try { await review(behaviors.find(item => item.behaviorId === button.dataset.id)); } catch (error) { toast(error.message); } } });
$('#new-behavior').addEventListener('click', () => { page('home'); $('#intent-input').focus(); });
$('#approve-plan').addEventListener('click', async (event) => { event.preventDefault(); if (!candidate || candidate.status === 'deployed') return; try { await api(`/behaviors/${candidate.behaviorId}/deploy`, { method: 'POST' }); $('#plan-dialog').close(); toast('Behavior deployed. Nexus will evaluate matching environment events.'); await refresh(); } catch (error) { toast(error.message); } });
$('#stop-all').addEventListener('click', () => toast('Emergency stop needs a dedicated runtime pause endpoint before it can safely affect deployed behaviors.'));
refresh().catch(error => toast(error.message));
