/**
 * Threadstreet's tests.
 *
 * These drive a real Chrome, because most of this app only exists once a
 * browser is running it: panels opening, pins appearing, the location rules.
 * Testing the server alone would miss all of it -- and did, twice.
 *
 * Nothing needs installing. Chrome is driven over its own DevTools Protocol,
 * using the WebSocket built into Node.
 *
 *   npm test
 *
 * It starts its own server on port 3100 with a throwaway database, so your own
 * server and messages.db are left alone.
 */

import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;
const DB_FILE = join(tmpdir(), `threadstreet-test-${process.pid}.db`);
const PROFILE = join(tmpdir(), `threadstreet-chrome-${process.pid}`);

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/* ------------------------------------------------------------- plumbing -- */

let passed = 0;
let failed = 0;
const failures = [];

function section(name) {
  console.log(`\n${name}`);
}

async function check(label, expression, expected) {
  const { value, error } = await evaluate(expression);
  const ok = error
    ? false
    : typeof expected === 'function'
      ? expected(value)
      : value === expected;

  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}  -> got ${JSON.stringify(error ?? value)}`);
  }
}

/**
 * Is an element really on the screen?
 *
 * Deliberately not `element.hidden`. That only reports the attribute, and an
 * element can carry it while remaining perfectly visible -- which is exactly
 * the bug that once shipped every panel open at once, past a green test run.
 */
const visible = (id) => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'no such element';
  const box = el.getBoundingClientRect();
  return el.offsetParent !== null && box.width > 0 && box.height > 0;
})()`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------ chrome plumbing -- */

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (reply.result?.exceptionDetails) {
    return { error: reply.result.exceptionDetails.exception?.description ?? 'threw' };
  }
  return { value: reply.result?.result?.value };
}

/** Click something by id and give the page a moment to react. */
async function click(id, settleMs = 400) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  await wait(settleMs);
}

async function setLocation(lat, lng, accuracy = 5) {
  await cdp('Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy });
  // Clear the page's two-minute cache so the next request really re-reads.
  await evaluate('myLocation = null');
}

/* ------------------------------------------------------------ the tests -- */

async function run() {
  section('a fresh page has nothing open');
  await check('map is visible', visible('map'), true);
  await check('hint is visible', visible('hint'), true);
  await check('locate button is visible', visible('locate'), true);
  await check('thread list is closed', visible('panel'), false);
  await check('thread panel is closed', visible('thread-panel'), false);
  await check('new-thread dialog is closed', visible('new-thread'), false);
  await check('backdrop is closed', visible('panel-backdrop'), false);

  section('the three dots open only the thread list');
  await click('panel-toggle');
  await check('list opened', visible('panel'), true);
  await check('thread panel stayed closed', visible('thread-panel'), false);
  await check('empty state shown', 'document.querySelector(".panel-empty") !== null', true);
  await click('panel-close');
  await check('list closed again', visible('panel'), false);

  section('starting a thread needs your location');
  await cdp('Browser.grantPermissions', { origin: ORIGIN, permissions: [] });
  await evaluate('map.fire("click", { latlng: L.latLng(51.5, -0.12) })');
  await wait(2500);
  await check('dialog opened', visible('new-thread'), true);
  await check('coordinates filled in', 'document.getElementById("new-thread-where").textContent', '51.50000, -0.12000');
  await check('Create is disabled', 'document.getElementById("new-thread-create").disabled', true);
  await check('says why', 'document.getElementById("new-thread-error").textContent', (t) => /permission|refused/i.test(t));
  await click('new-thread-cancel');
  await check('cancel closed it', visible('new-thread'), false);

  section('a spot more than 10 m away is refused');
  await cdp('Browser.grantPermissions', { origin: ORIGIN, permissions: ['geolocation'] });
  await setLocation(51.5, -0.12);
  await evaluate('map.fire("click", { latlng: L.latLng(48.8584, 2.2945) })');
  await wait(2500);
  await check('Create is disabled', 'document.getElementById("new-thread-create").disabled', true);
  await check('reports the distance', 'document.getElementById("new-thread-locating").textContent', (t) => /away/.test(t) && /within 10 m/.test(t));
  await check('offers to move the pin', visible('new-thread-use-mine'), true);

  section('"put the pin where I am" makes it valid');
  await click('new-thread-use-mine', 900);
  await check('Create is enabled', 'document.getElementById("new-thread-create").disabled', false);
  await check('pin moved onto me', 'document.getElementById("new-thread-where").textContent', '51.50000, -0.12000');
  await check('offer withdrawn', visible('new-thread-use-mine'), false);

  section('creating the thread');
  await evaluate(`(() => {
    document.getElementById("new-thread-title").value = "Home";
    document.getElementById("new-thread-body").value = "root message";
  })()`);
  await click('new-thread-create', 2200);
  await check('dialog closed', visible('new-thread'), false);
  await check('thread panel opened', visible('thread-panel'), true);
  await check('title shown', 'document.getElementById("thread-title").textContent', 'Home');
  await check('first message listed', 'document.querySelector(".msg-body").textContent', 'root message');
  await check('pin drawn', 'document.querySelectorAll(".leaflet-marker-icon").length', 1);
  await check('creator position stored', `fetch('/api/threads/1').then(r => r.json()).then(t => t.creator_lat !== null)`, true);
  await check('header reports the distance', 'document.getElementById("thread-meta").textContent', (t) => /started from/.test(t));

  section('anyone, anywhere, can write');
  await setLocation(40, -70);
  await evaluate(`(() => {
    const box = document.getElementById("thread-input");
    box.value = "written from far away";
    box.dispatchEvent(new Event("input"));
  })()`);
  await click('thread-send', 1600);
  await check('message posted', 'document.querySelectorAll(".msg").length', 2);
  await check('input cleared', 'document.getElementById("thread-input").value', '');

  section('replies nest under their parent');
  await evaluate('document.querySelectorAll(".msg")[0].querySelector(".link-btn").click()');
  await wait(300);
  await check('replying bar shown', visible('replying-to'), true);
  await evaluate(`(() => {
    const box = document.getElementById("thread-input");
    box.value = "a reply";
    box.dispatchEvent(new Event("input"));
  })()`);
  await click('thread-send', 1600);
  await check('three messages', 'document.querySelectorAll(".msg").length', 3);
  await check('reply is nested', 'document.querySelectorAll(".msg")[0].querySelectorAll(".msg").length', 1);
  await check('replying bar cleared', visible('replying-to'), false);

  section('deleting from far away is refused');
  await setLocation(40, -70);
  await evaluate('window.confirm = () => true');
  await evaluate('document.querySelectorAll(".msg")[1].querySelector(".link-danger").click()');
  await wait(2500);
  await check('explains the distance', 'document.getElementById("toast").textContent', (t) => /within 10 m/.test(t));
  await check('nothing was deleted', 'document.querySelectorAll(".msg").length', 3);

  section('the server refuses too, whatever the page does');
  await check('no coordinates -> 403', `fetch('/api/messages/2', { method: 'DELETE' }).then(r => r.status)`, 403);
  await check('far coordinates -> 403', `fetch('/api/messages/2?lat=40&lng=-70', { method: 'DELETE' }).then(r => r.status)`, 403);
  await check('thread delete far away -> 403', `fetch('/api/threads/1?lat=40&lng=-70', { method: 'DELETE' }).then(r => r.status)`, 403);
  await check('pin far from creator -> 403', `fetch('/api/threads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Cheat', body: 'x', lat: 0, lng: 0, creatorLat: 51.5, creatorLng: -0.12 })
  }).then(r => r.status)`, 403);
  await check('still three messages', `fetch('/api/threads/1').then(r => r.json()).then(t => t.messages.length)`, 3);

  section('deleting a message that has replies leaves a placeholder');
  await setLocation(51.5, -0.12);
  await evaluate('document.querySelectorAll(".msg")[0].querySelector(".link-danger").click()');
  await wait(2000);
  await check('still three nodes', 'document.querySelectorAll(".msg").length', 3);
  await check('shows as deleted', 'document.querySelectorAll(".msg-body")[0].textContent', 'Message deleted');
  await check('no actions on it', 'document.querySelectorAll(".msg")[0].querySelector(".msg-foot").children.length', 1);
  await check('the reply survived', 'document.body.textContent.includes("a reply")', true);

  section('a message with no replies is removed outright');
  await setLocation(51.5, -0.12);
  await evaluate('document.querySelectorAll(".msg")[2].querySelector(".link-danger").click()');
  await wait(2000);
  await check('one fewer node', 'document.querySelectorAll(".msg").length', 2);
  await check('gone, not a placeholder', 'document.body.textContent.includes("written from far away")', false);

  section('the thread list toggles, and closing it does not close the list');
  await check('both panels open', `${visible('panel')} && ${visible('thread-panel')}`, true);
  await click('thread-close');
  await check('thread panel closed', visible('thread-panel'), false);
  await check('LIST STAYED OPEN', visible('panel'), true);
  await evaluate('document.querySelectorAll(".panel-item")[0].click()');
  await wait(1600);
  await check('row opens the thread', visible('thread-panel'), true);
  await evaluate('document.querySelectorAll(".panel-item")[0].click()');
  await wait(700);
  await check('same row closes it', visible('thread-panel'), false);
  await evaluate('document.querySelectorAll(".panel-item")[0].click()');
  await wait(1600);
  await check('and opens it again', visible('thread-panel'), true);

  section('tapping an existing pin opens it rather than starting a new thread');
  await click('panel-close');
  await evaluate('map.fire("click", { latlng: L.latLng(51.5, -0.12) })');
  await wait(1600);
  await check('no new-thread dialog', visible('new-thread'), false);
  await check('the thread opened', visible('thread-panel'), true);

  section('deleting a whole thread');
  await setLocation(51.5, -0.12);
  await evaluate('window.__confirms = []; window.confirm = (m) => { window.__confirms.push(m); return true; }');
  await click('thread-delete', 2200);
  await check('asked first', 'window.__confirms.length', 1);
  await check('named the thread', 'window.__confirms[0]', (t) => /Home/.test(t));
  await check('panel closed', visible('thread-panel'), false);
  await check('pin removed', 'document.querySelectorAll(".leaflet-marker-icon").length', 0);
  await check('server has none', `fetch('/api/threads').then(r => r.json()).then(a => a.length)`, 0);

  section('text is never treated as HTML');
  await setLocation(-33.8688, 151.2093);
  await evaluate('map.fire("click", { latlng: L.latLng(-33.8688, 151.2093) })');
  await wait(2500);
  await evaluate(`(() => {
    document.getElementById("new-thread-title").value = '<img src=x onerror="window.PWNED=1">';
    document.getElementById("new-thread-body").value = '<b>bold?</b>';
  })()`);
  await click('new-thread-create', 2200);
  await check('no script ran', 'window.PWNED === undefined', true);
  await check('shown as literal text', 'document.querySelector(".msg-body").textContent', '<b>bold?</b>');
  await check('no element was created', 'document.querySelector(".msg-body b") === null', true);
  await evaluate('markers.values().next().value.openTooltip()');
  await wait(300);
  await check('tooltip is text too', 'document.querySelector(".leaflet-tooltip img") === null', true);
  await check('still no script ran', 'window.PWNED === undefined', true);
}

/* --------------------------------------------------------------- runner -- */

let server;
let chrome;

/**
 * Shut everything down and remove the temporary files.
 *
 * Every step is allowed to fail. Chrome may still be writing to its profile
 * directory as we delete it, and a tidy-up that throws would turn a passing
 * test run into a failing one -- reporting a problem that does not exist.
 */
async function cleanUp() {
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}

  // Give Chrome a moment to let go of its files.
  await wait(500);

  for (const path of [DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`, PROFILE]) {
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // A leftover file in the system temp directory is harmless.
    }
  }
}

async function waitForHttp(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await wait(500);
    }
  }
  return false;
}

try {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    console.error('\nNo Chrome or Chromium found. These tests drive a real browser.');
    console.error('Looked in:\n  ' + CHROME_PATHS.join('\n  '));
    process.exit(1);
  }

  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: 'ignore',
  });

  if (!(await waitForHttp(`${ORIGIN}/api/threads`))) {
    throw new Error(`The server never came up on ${ORIGIN}`);
  }

  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=9333',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  if (!(await waitForHttp('http://localhost:9333/json/version'))) {
    throw new Error('Chrome never opened its debugging port');
  }

  const pages = await (await fetch('http://localhost:9333/json/list')).json();
  const page = pages.find((p) => p.type === 'page');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);

    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      consoleErrors.push(details.exception?.description ?? details.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp('Page.navigate', { url: `${ORIGIN}/` });
  await wait(3500);

  await run();

  console.log(`\n  ${passed} passed, ${failed} failed`);

  if (consoleErrors.length > 0) {
    console.log('\n  errors reported by the browser:');
    consoleErrors.forEach((e) => console.log(`    ${e}`));
  }

  if (failed > 0) {
    console.log('\n  failing:');
    failures.forEach((f) => console.log(`    ${f}`));
  }

  await cleanUp();
  process.exit(failed > 0 || consoleErrors.length > 0 ? 1 : 0);
} catch (error) {
  console.error('\nThe test run could not finish:', error.message);
  await cleanUp();
  process.exit(1);
}
