/* /lock — the passcode page. Nothing else lives here. */
import * as cloud from './api.js';
import { $, registerSW } from './shared.js';

const next = new URLSearchParams(location.search).get('next') || '/';

async function init() {
  if (cloud.getToken()) return location.replace(next);
  let first = false;
  try { first = !(await cloud.status()).configured; } catch {}
  $('lockTitle').textContent = first ? 'Choose a passcode' : 'Enter passcode';
  $('lockSub').textContent = first
    ? 'You only set this once. It unlocks your photos on any device.'
    : 'Sign in to see your photos';
  setTimeout(() => $('lockPass').focus(), 150);
}

async function doLogin() {
  const pass = $('lockPass').value.trim();
  if (pass.length < 4) return fail('At least 4 characters');
  $('lockGo').disabled = true; $('lockGo').textContent = 'Checking…';
  try {
    await cloud.login(pass);
    cloud.flush();
    location.replace(next);
  } catch (e) { fail(String(e.message || e)); }
  finally { $('lockGo').disabled = false; $('lockGo').textContent = 'Continue'; }
}
function fail(msg) {
  const el = $('lockErr');
  el.hidden = true; void el.offsetWidth;
  el.textContent = msg; el.hidden = false;
}

$('lockGo').onclick = doLogin;
$('lockPass').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
$('lockSkip').onclick = () => { localStorage.setItem('snapz_nocloud', '1'); location.replace('/'); };

registerSW();
init();
