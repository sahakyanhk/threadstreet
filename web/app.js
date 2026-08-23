/**
 * Threadstreet -- the whole website.
 *
 * Runs inside the visitor's browser. Talks to server.js over the network.
 *
 * A THREAD is a pin on the map: a place with a name.
 * Anyone can add messages to a thread, or reply to a message inside it.
 *
 * Tap a pin (or a thread in the list) to read it. Tap empty map to start one.
 */

/* ------------------------------------------------------------- the map -- */

// zoomControl: false turns off Leaflet's default zoom buttons so we can put
// our own in the bottom-left corner instead.
const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);

L.control.zoom({ position: 'bottomleft' }).addTo(map);

// The map picture itself: small square images from OpenStreetMap, free to use.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

/**
 * How close you must be to start a thread somewhere, or to delete anything in
 * it. Writing a message needs no such thing. The server checks this too -- this
 * copy is only so the page can explain itself before asking.
 */
const NEARBY_METRES = 10;

// Every thread pin we have drawn, keyed by thread id.
const markers = new Map();

// The most recent list of threads from the server.
let threads = [];

// Which thread is open in the right-hand panel, and where it is.
let openThreadId = null;
let openThreadAt = null;

// Which message the next send should reply to. null means "add to the thread".
let replyingTo = null;

/* -------------------------------------------------------- the page bits -- */

const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const toastEl = document.getElementById('toast');

const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panel-toggle');
const panelClose = document.getElementById('panel-close');
const panelBackdrop = document.getElementById('panel-backdrop');
const threadList = document.getElementById('thread-list');

const threadPanel = document.getElementById('thread-panel');
const threadTitle = document.getElementById('thread-title');
const threadMeta = document.getElementById('thread-meta');
const threadMessages = document.getElementById('thread-messages');
const threadBack = document.getElementById('thread-back');
const threadCloseBtn = document.getElementById('thread-close');
const threadDeleteBtn = document.getElementById('thread-delete');
const threadInput = document.getElementById('thread-input');
const threadSend = document.getElementById('thread-send');
const replyingBar = document.getElementById('replying-to');
const replyingText = document.getElementById('replying-to-text');
const replyingCancel = document.getElementById('replying-cancel');

const locateBtn = document.getElementById('locate');

const newThread = document.getElementById('new-thread');
const newThreadWhere = document.getElementById('new-thread-where');
const newThreadTitle = document.getElementById('new-thread-title');
const newThreadBody = document.getElementById('new-thread-body');
const newThreadError = document.getElementById('new-thread-error');
const newThreadLocating = document.getElementById('new-thread-locating');
const newThreadUseMine = document.getElementById('new-thread-use-mine');
const newThreadCreate = document.getElementById('new-thread-create');
const newThreadCancel = document.getElementById('new-thread-cancel');

/* ------------------------------------------------------------- threads -- */

/** Ask the server for every thread, draw the pins, fill the list. */
async function loadThreads() {
  try {
    const response = await fetch('/api/threads');
    threads = await response.json();

    threads.forEach(drawPin);

    // Take away pins whose thread has been deleted, by us or by someone else.
    const live = new Set(threads.map((t) => t.id));
    for (const [id, marker] of markers) {
      if (!live.has(id)) {
        map.removeLayer(marker);
        markers.delete(id);
      }
    }

    renderThreadList();

    const n = threads.length;
    statusEl.textContent = n === 0 ? 'No threads yet' : `${n} thread${n === 1 ? '' : 's'}`;
  } catch {
    statusEl.textContent = 'Could not reach the server';
  }
}

function drawPin(thread) {
  if (markers.has(thread.id)) return;

  // The tooltip content is built as a DOM element rather than passed as a
  // string. Leaflet writes string content straight into innerHTML, which would
  // turn a thread named "<img onerror=...>" into running code. Setting
  // textContent on an element we make ourselves cannot do that.
  const label = document.createElement('span');
  label.textContent = thread.title;

  const marker = L.marker([thread.lat, thread.lng])
    .bindTooltip(label)
    .addTo(map);

  // Tapping a pin opens its thread. Leaflet keeps marker clicks separate from
  // map clicks, so this never triggers the "start a new thread" question.
  marker.on('click', () => openThread(thread.id));

  markers.set(thread.id, marker);
}

function renderThreadList() {
  threadList.replaceChildren();

  if (threads.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'panel-empty';
    empty.textContent = 'No threads yet. Tap the map to start one.';
    threadList.append(empty);
    return;
  }

  for (const thread of threads) {
    const item = document.createElement('li');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-item';

    // textContent, not innerHTML: the browser treats this strictly as text, so
    // a name containing HTML can never become HTML here.
    const title = document.createElement('p');
    title.className = 'panel-item-body';
    title.textContent = thread.title;

    const meta = document.createElement('p');
    meta.className = 'panel-item-time';
    meta.textContent =
      `${thread.message_count} message${thread.message_count === 1 ? '' : 's'}` +
      (thread.last_at ? ` · ${timeAgo(thread.last_at)}` : '');

    button.append(title, meta);

    // Clicking the thread already showing closes the panel again, so the same
    // row acts as an on/off switch. Clicking a different one just switches.
    button.addEventListener('click', () => {
      if (openThreadId === thread.id && !threadPanel.hidden) closeThread();
      else openThread(thread.id);
    });

    item.append(button);
    threadList.append(item);
  }
}

/* -------------------------------------------------------- one thread -- */

/** Load a thread and show it in the right-hand panel. */
async function openThread(id) {
  openPanel();

  try {
    const response = await fetch(`/api/threads/${id}`);
    if (!response.ok) throw new Error('That thread is gone.');

    const thread = await response.json();

    openThreadId = id;
    openThreadAt = { lat: thread.lat, lng: thread.lng };
    setReplyingTo(null);
    threadPanel.hidden = false;

    threadTitle.textContent = thread.title;
    threadMeta.textContent = describeThread(thread);

    renderMessages(thread.messages);

    // Move the map to the thread, then open nothing -- the panel is the reader.
    map.flyTo([thread.lat, thread.lng], Math.max(map.getZoom(), 15));
  } catch (error) {
    showToast(error.message);
  }
}

/**
 * Draw the messages as a tree.
 *
 * Each message may name another as its parent. Turning that flat list into
 * nested replies is done here rather than on the server, because it is purely
 * about how it looks.
 */
function renderMessages(messages) {
  const byId = new Map(messages.map((m) => [m.id, { ...m, children: [] }]));
  const roots = [];

  for (const message of byId.values()) {
    const parent = message.parent_id ? byId.get(message.parent_id) : null;
    if (parent) parent.children.push(message);
    else roots.push(message);
  }

  threadMessages.replaceChildren();
  roots.forEach((message) => threadMessages.append(renderMessage(message, 0)));
}

function renderMessage(message, depth) {
  const item = document.createElement('li');
  item.className = 'msg';
  // Indent replies, but stop indenting after a few levels so deep chains do not
  // shrink into a sliver at the right-hand edge.
  item.style.marginLeft = `${Math.min(depth, 4) * 14}px`;

  const deleted = Boolean(message.deleted_at);

  const body = document.createElement('p');
  body.className = deleted ? 'msg-body msg-deleted' : 'msg-body';
  body.textContent = deleted ? 'Message deleted' : message.body;

  const foot = document.createElement('p');
  foot.className = 'msg-foot';

  const when = document.createElement('span');
  when.textContent = timeAgo(message.created_at);
  foot.append(when);

  // A deleted message is only a placeholder holding its replies in place --
  // there is nothing left to reply to or delete.
  if (!deleted) {
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'link-btn';
    replyBtn.textContent = 'Reply';
    replyBtn.addEventListener('click', () => setReplyingTo(message));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'link-btn link-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteMessage(message));

    foot.append(replyBtn, deleteBtn);
  }

  item.append(body, foot);

  for (const child of message.children) {
    item.append(renderMessage(child, depth + 1));
  }

  return item;
}

/** Point the send box at a message, or back at the thread as a whole. */
function setReplyingTo(message) {
  replyingTo = message ? message.id : null;

  if (message) {
    replyingBar.hidden = false;
    replyingText.textContent = `Replying to “${truncate(message.body, 40)}”`;
    threadInput.placeholder = 'Write a reply…';
  } else {
    replyingBar.hidden = true;
    threadInput.placeholder = 'Add to this thread…';
  }

  threadInput.focus();
}

replyingCancel.addEventListener('click', () => setReplyingTo(null));

threadInput.addEventListener('input', () => {
  threadSend.disabled = threadInput.value.trim() === '';
});

threadSend.addEventListener('click', async () => {
  const text = threadInput.value.trim();
  if (!openThreadId || text === '') return;

  threadSend.disabled = true;
  threadSend.textContent = 'Sending…';

  try {
    const response = await fetch(`/api/threads/${openThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, parentId: replyingTo }),
    });

    const thread = await response.json();
    if (!response.ok) throw new Error(thread.error ?? 'Could not send.');

    threadInput.value = '';
    setReplyingTo(null);
    renderMessages(thread.messages);
    threadMeta.textContent = describeThread(thread);

    loadThreads();   // refresh counts in the list behind
  } catch (error) {
    showToast(error.message);
  } finally {
    threadSend.textContent = 'Send';
    threadSend.disabled = threadInput.value.trim() === '';
  }
});

/**
 * Delete a message.
 *
 * Asked for first, because it cannot be undone and, with no accounts, this may
 * well be somebody else's message.
 */
async function deleteMessage(message) {
  const here = await requireNearby();
  if (!here) return;

  const preview = truncate(message.body, 60);
  if (!window.confirm(`Delete this message?\n\n“${preview}”\n\nThis cannot be undone.`)) return;

  try {
    const response = await fetch(
      `/api/messages/${message.id}?lat=${here.lat}&lng=${here.lng}`,
      { method: 'DELETE' }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not delete.');

    // Deleting the last readable message takes the whole thread with it.
    if (result.threadDeleted) {
      closeThread();
      await loadThreads();
      showToast('Message deleted. The thread had nothing left, so it is gone too.');
      return;
    }

    // If the message being replied to has just gone, stop replying to it.
    if (replyingTo === message.id) setReplyingTo(null);

    renderMessages(result.messages);
    threadMeta.textContent = describeThread(result);
    loadThreads();
  } catch (error) {
    showToast(error.message);
  }
}

/**
 * Delete a whole thread, and every message in it.
 */
async function deleteThread() {
  if (!openThreadId) return;

  const here = await requireNearby();
  if (!here) return;

  const count = threadMessages.querySelectorAll('.msg').length;
  const name = threadTitle.textContent;

  if (!window.confirm(
    `Delete the whole thread “${name}”?\n\n` +
    `All ${count} message${count === 1 ? '' : 's'} in it will go, and its pin ` +
    `will disappear from the map.\n\nThis cannot be undone.`
  )) return;

  try {
    const response = await fetch(
      `/api/threads/${openThreadId}?lat=${here.lat}&lng=${here.lng}`,
      { method: 'DELETE' }
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not delete the thread.');

    closeThread();
    await loadThreads();      // also takes the pin off the map
    showToast(`Thread “${name}” deleted.`);
  } catch (error) {
    showToast(error.message);
  }
}

threadDeleteBtn.addEventListener('click', deleteThread);

/**
 * Confirm the visitor is standing at the open thread before deleting anything.
 *
 * Returns their position, or null after explaining why not. Asked for only when
 * a delete is actually attempted, so simply reading a thread never prompts.
 */
async function requireNearby() {
  if (!openThreadAt) return null;

  let here;
  try {
    here = await getMyLocation();
  } catch (error) {
    showToast(`Deleting needs your location. ${error.message}`);
    return null;
  }

  const away = distanceInMetres(
    openThreadAt.lat, openThreadAt.lng, here.lat, here.lng
  );

  if (away > NEARBY_METRES) {
    showToast(
      `You are ${Math.round(away)} m from this thread. ` +
      `You can only delete things within ${NEARBY_METRES} m of it.`
    );
    return null;
  }

  return here;
}

function closeThread() {
  threadPanel.hidden = true;
  openThreadId = null;
  openThreadAt = null;
  threadInput.value = '';
  threadSend.disabled = true;
  setReplyingTo(null);
}

// Both of these close only the thread panel. The list stays open behind it --
// closing the list is what the × on the list itself is for.
threadBack.addEventListener('click', closeThread);
threadCloseBtn.addEventListener('click', closeThread);

/* ----------------------------------------------------------- the panel -- */

function openPanel() {
  panel.hidden = false;
  panelBackdrop.hidden = false;
  panelToggle.setAttribute('aria-expanded', 'true');
}

function closePanel() {
  panel.hidden = true;
  panelBackdrop.hidden = true;
  panelToggle.setAttribute('aria-expanded', 'false');
  closeThread();
}

panelToggle.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
panelClose.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!newThread.hidden) closeNewThread();
  else if (!threadPanel.hidden) closeThread();
  else if (!panel.hidden) closePanel();
});

/* ------------------------------------------------- tapping the map ----- */

// Where the pending new thread would go.
let newThreadAt = null;

map.on('click', (event) => {
  // Is there already a thread on this spot? Marker clicks are handled by
  // Leaflet separately, but a tap just beside a pin still counts as "here" --
  // so measure in screen pixels, which stays sensible at every zoom level.
  const nearby = findThreadNear(event.latlng);

  if (nearby) {
    openThread(nearby.id);
    return;
  }

  openNewThread(event.latlng);
});

/** The closest thread within 22 pixels of a point, or null. */
function findThreadNear(latlng) {
  const point = map.latLngToContainerPoint(latlng);
  let best = null;
  let bestDistance = 22;

  for (const thread of threads) {
    const other = map.latLngToContainerPoint([thread.lat, thread.lng]);
    const distance = point.distanceTo(other);
    if (distance < bestDistance) {
      best = thread;
      bestDistance = distance;
    }
  }

  return best;
}

async function openNewThread(latlng) {
  newThreadAt = latlng;
  newThreadWhere.textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  newThreadError.hidden = true;
  newThread.hidden = false;
  newThreadTitle.focus();

  // Starting a thread requires sharing where you are, so ask straight away.
  // The dialog opens first regardless, so the tap always visibly does
  // something while the browser waits on its permission prompt.
  newThreadLocating.textContent = 'Checking your location…';
  newThreadCreate.disabled = true;

  try {
    const position = await getMyLocation();

    // The visitor may have cancelled while the prompt was up.
    if (newThread.hidden) return;

    showYouAreHere(position);
    judgeDistance();
  } catch (error) {
    if (newThread.hidden) return;
    newThreadLocating.textContent = 'Starting a thread needs your location.';
    newThreadError.textContent = error.message;
    newThreadError.hidden = false;
  }
}

/**
 * Decide whether the pending pin is close enough to the visitor to allow it.
 *
 * At street zoom, ten metres is only a few pixels wide -- far too small to hit
 * by tapping. So when the spot is out of reach we offer to move the pin onto
 * their own position instead, which is the only way this rule is workable.
 */
function judgeDistance() {
  if (!myLocation || !newThreadAt) return;

  const away = distanceInMetres(
    newThreadAt.lat, newThreadAt.lng, myLocation.lat, myLocation.lng
  );

  if (away <= NEARBY_METRES) {
    newThreadLocating.textContent =
      `You are ${Math.round(away)} m from this spot. Your location is saved with the thread ` +
      `(accurate to about ${Math.round(myLocation.accuracy)} m).`;
    newThreadCreate.disabled = false;
    newThreadUseMine.hidden = true;
    newThreadError.hidden = true;
  } else {
    newThreadLocating.textContent =
      `That spot is ${Math.round(away)} m away. Threads can only be started ` +
      `within ${NEARBY_METRES} m of where you are.`;
    newThreadCreate.disabled = true;
    newThreadUseMine.hidden = false;
  }
}

/** Move the pending pin onto the visitor's own position. */
newThreadUseMine.addEventListener('click', () => {
  if (!myLocation) return;

  newThreadAt = L.latLng(myLocation.lat, myLocation.lng);
  newThreadWhere.textContent =
    `${newThreadAt.lat.toFixed(5)}, ${newThreadAt.lng.toFixed(5)}`;

  map.setView(newThreadAt, Math.max(map.getZoom(), 18));
  judgeDistance();
});

function closeNewThread() {
  newThread.hidden = true;
  newThreadAt = null;
  newThreadTitle.value = '';
  newThreadBody.value = '';
  newThreadError.hidden = true;
  newThreadLocating.textContent = 'Checking your location…';
  newThreadCreate.disabled = true;
  newThreadUseMine.hidden = true;
}

newThreadCancel.addEventListener('click', closeNewThread);

newThreadCreate.addEventListener('click', async () => {
  if (!newThreadAt) return;

  newThreadCreate.disabled = true;
  newThreadCreate.textContent = 'Creating…';

  try {
    const response = await fetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newThreadTitle.value,
        body: newThreadBody.value,
        lat: newThreadAt.lat,
        lng: newThreadAt.lng,
        // Where the person starting it actually is, saved as thread metadata.
        creatorLat: myLocation?.lat,
        creatorLng: myLocation?.lng,
        creatorAccuracy: myLocation?.accuracy,
      }),
    });

    const thread = await response.json();
    if (!response.ok) throw new Error(thread.error ?? 'Could not create the thread.');

    closeNewThread();
    await loadThreads();
    openThread(thread.id);
  } catch (error) {
    newThreadError.textContent = error.message;
    newThreadError.hidden = false;
  } finally {
    newThreadCreate.textContent = 'Create thread';
    // Re-apply the distance rule rather than simply switching the button back
    // on: if the attempt failed because the spot is out of range, it must stay
    // disabled.
    judgeDistance();
  }
});

/* -------------------------------------------------------- find my place -- */

// The dot and accuracy ring showing where the browser thinks you are.
let youAreHere = null;

// The last position the browser gave us, and when. Reused for a couple of
// minutes so that starting several threads does not re-prompt every time.
let myLocation = null;

/**
 * Get the visitor's position, asking the browser if we do not have a recent one.
 *
 * Returns a promise so callers can simply await it. The browser's own
 * permission prompt appears the first time; we cannot skip it, restyle it, or
 * ask again once someone has refused -- that is the browser's decision.
 */
function getMyLocation({ maxAgeMs = 120000 } = {}) {
  if (myLocation && Date.now() - myLocation.at < maxAgeMs) {
    return Promise.resolve(myLocation);
  }

  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) {
      reject(new Error('Sharing your location needs a secure (https) address. Works on localhost, or through a tunnel.'));
      return;
    }
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share a location.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        myLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          at: Date.now(),
        };
        resolve(myLocation);
      },
      (error) => {
        // error.code is a number the browser sets. Each one needs a different
        // fix, so a single "something went wrong" message would be useless.
        const reasons = {
          1: 'Location permission was refused. Allow it for this site in your browser settings — on a Mac, also check System Settings → Privacy & Security → Location Services.',
          2: 'Your location is unavailable. Desktops without GPS often cannot work it out.',
          3: 'Finding your location took too long. Try again.',
        };
        reject(new Error(reasons[error.code] ?? 'Could not find your location.'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

locateBtn.addEventListener('click', async () => {
  locateBtn.classList.add('is-busy');

  try {
    // Force a fresh reading: pressing this button means "where am I now".
    const position = await getMyLocation({ maxAgeMs: 0 });
    showYouAreHere(position);
    map.flyTo([position.lat, position.lng], 16);
    showToast(`Found you, give or take ${Math.round(position.accuracy)} m.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    locateBtn.classList.remove('is-busy');
  }
});

/** Draw the blue dot and its accuracy ring. */
function showYouAreHere({ lat, lng, accuracy }) {
  if (youAreHere) map.removeLayer(youAreHere);

  // A dot for the position, and a ring showing how uncertain it is. On a
  // desktop with no GPS that ring is often hundreds of metres wide.
  youAreHere = L.layerGroup([
    L.circleMarker([lat, lng], {
      radius: 7, color: '#fff', weight: 2, fillColor: '#1d4ed8', fillOpacity: 1,
    }),
    L.circle([lat, lng], {
      radius: accuracy, color: '#1d4ed8', weight: 1, fillOpacity: 0.1,
    }),
  ]).addTo(map);
}

/* ------------------------------------------------------------ helpers -- */

/**
 * The line under a thread's name: how many messages, and how far the person who
 * started it was from the pin they dropped.
 */
function describeThread(thread) {
  const count = thread.messages.length;
  let text = `${count} message${count === 1 ? '' : 's'}`;

  if (typeof thread.creator_lat === 'number' && typeof thread.creator_lng === 'number') {
    const metres = distanceInMetres(
      thread.lat, thread.lng, thread.creator_lat, thread.creator_lng
    );
    text += metres < 1000
      ? ` · started from ${Math.round(metres)} m away`
      : ` · started from ${(metres / 1000).toFixed(1)} km away`;
  }

  return text;
}

/**
 * Distance between two points on the globe, in metres.
 *
 * This is the haversine formula. It treats the Earth as a sphere, which is
 * close enough for anything at street scale.
 */
function distanceInMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;                       // the Earth's radius in metres
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

let toastTimer = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 7000);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function timeAgo(isoString) {
  const seconds = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(isoString).toLocaleDateString();
}

/* -------------------------------------------------------------- start -- */

loadThreads();

// Pick up other people's new threads every 10 seconds.
setInterval(loadThreads, 10000);
