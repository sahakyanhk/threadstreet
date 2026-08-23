/**
 * Threadstreet -- the entire server.
 *
 * Two jobs:
 *   1. Hand out the website files in web/ to anyone who visits.
 *   2. Store and return threads and their messages, as JSON, under /api/.
 *
 * The shape of the data:
 *   A THREAD is a place on the map. It has a name and a position.
 *   A MESSAGE belongs to a thread. Anyone may add one.
 *   A message may point at another message as its parent -- that is a reply.
 *
 * Read it top to bottom. It runs in the order it is written.
 */

import express from 'express';
import { DatabaseSync } from 'node:sqlite';

// Both can be overridden when starting the server, which is how the test suite
// runs against a throwaway database on a different port without disturbing
// anything you are working on.
const PORT = Number(process.env.PORT ?? 3000);
const DB_FILE = process.env.DB_FILE ?? 'messages.db';
const MAX_TITLE = 80;
const MAX_BODY = 280;

/**
 * How close you must be to a place to start a thread there, or to delete
 * anything in it. Writing a message needs no such thing -- anyone, anywhere.
 *
 * Be clear about what this is: the browser reports its own position, so someone
 * willing to send their own requests can claim to be anywhere. It is a rule of
 * the game, not a lock. Accounts and server-side trust are what would make it
 * enforceable.
 */
const NEARBY_METRES = 10;

/* ------------------------------------------------------------- database -- */

// Creates messages.db in this folder the first time it runs. Delete that file
// to wipe everything and start over.
const db = new DatabaseSync(DB_FILE);

/**
 * Earlier versions stored a flat list of messages with no threads. Those rows
 * cannot be fitted into the new shape, so they are dropped rather than left to
 * cause confusing errors. Said out loud, because silently deleting someone's
 * data would be worse.
 */
const existing = db.prepare('PRAGMA table_info(messages)').all();
if (existing.length > 0 && !existing.some((c) => c.name === 'thread_id')) {
  console.log('Old database format found — clearing it and starting fresh.');
  db.exec('DROP TABLE messages');
}

// Runs every startup. IF NOT EXISTS means it does nothing after the first time.
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    title              TEXT NOT NULL,
    lat                REAL NOT NULL,
    lng                REAL NOT NULL,
    created_at         TEXT NOT NULL,

    -- Where the person who started this thread actually was at the time,
    -- according to their device. Kept as metadata: the pin above is wherever
    -- they chose to put it, which need not be the same place.
    creator_lat        REAL,
    creator_lng        REAL,
    creator_accuracy_m REAL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  INTEGER NOT NULL,
    parent_id  INTEGER,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,

    -- Set when a message is deleted but has to stay as a placeholder, so the
    -- replies hanging off it are not dragged down with it.
    deleted_at TEXT,
    FOREIGN KEY (thread_id) REFERENCES threads (id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id);
`);

/**
 * Adding columns to a table that already exists.
 *
 * CREATE TABLE IF NOT EXISTS does nothing at all when the table is already
 * there -- including when it is missing newer columns. So databases made by an
 * earlier version need the columns added explicitly. This is a migration: a
 * small, one-way step that brings an old database up to the current shape
 * without throwing away what is in it.
 */
const threadColumns = db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name);

for (const column of ['creator_lat', 'creator_lng', 'creator_accuracy_m']) {
  if (!threadColumns.includes(column)) {
    db.exec(`ALTER TABLE threads ADD COLUMN ${column} REAL`);
    console.log(`Database updated: added threads.${column}`);
  }
}

const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);

if (!messageColumns.includes('deleted_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
  console.log('Database updated: added messages.deleted_at');
}

/* --------------------------------------------------------------- server -- */

const app = express();

// Read JSON that browsers send us.
app.use(express.json());

// Serve index.html, app.js and style.css from the web/ folder.
app.use(express.static('web'));

/**
 * GET /api/threads -- every thread, for drawing pins and filling the list.
 *
 * Each one carries how many messages it holds and when it was last active, so
 * the list can show that without asking for every message in every thread.
 */
app.get('/api/threads', (req, res) => {
  const threads = db
    .prepare(
      `SELECT t.id, t.title, t.lat, t.lng, t.created_at,
              COUNT(m.id) AS message_count,
              MAX(m.created_at) AS last_at
         FROM threads t
         LEFT JOIN messages m ON m.thread_id = t.id
        GROUP BY t.id
        ORDER BY t.id DESC
        LIMIT 500`
    )
    .all();

  res.json(threads);
});

/**
 * POST /api/threads -- start a thread at a place.
 * Expects JSON: { title, lat, lng, body }
 *
 * The first message is created at the same time, so a thread is never empty.
 */
app.post('/api/threads', (req, res) => {
  const { title, lat, lng, body, creatorLat, creatorLng, creatorAccuracy } = req.body;

  const titleError = checkText(title, MAX_TITLE, 'Name');
  if (titleError) return res.status(400).json({ error: titleError });

  const bodyError = checkText(body, MAX_BODY, 'First message');
  if (bodyError) return res.status(400).json({ error: bodyError });

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Need a lat and lng as numbers.' });
  }

  // Starting a thread requires the creator to share where they are. Adding a
  // message to an existing thread does not -- only starting one.
  //
  // Worth being clear about what this does and does not achieve: it is the
  // visitor's own browser reporting its position, so it proves someone allowed
  // the prompt, not that they were truly standing there.
  if (typeof creatorLat !== 'number' || typeof creatorLng !== 'number') {
    return res.status(400).json({
      error: 'Starting a thread needs your location. Allow it and try again.',
    });
  }

  // The pin may only be dropped near where the creator actually is.
  const away = distanceInMetres(lat, lng, creatorLat, creatorLng);
  if (away > NEARBY_METRES) {
    return res.status(403).json({
      error: `That spot is ${Math.round(away)} m from you. Threads can only be started within ${NEARBY_METRES} m of where you are.`,
    });
  }

  const now = new Date().toISOString();

  const threadResult = db
    .prepare(
      `INSERT INTO threads (title, lat, lng, created_at,
                            creator_lat, creator_lng, creator_accuracy_m)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title.trim().slice(0, MAX_TITLE), lat, lng, now,
      creatorLat, creatorLng,
      typeof creatorAccuracy === 'number' ? creatorAccuracy : null
    );

  const threadId = Number(threadResult.lastInsertRowid);

  db.prepare(
    'INSERT INTO messages (thread_id, parent_id, body, created_at) VALUES (?, NULL, ?, ?)'
  ).run(threadId, body.trim().slice(0, MAX_BODY), now);

  res.json(getThread(threadId));
});

/**
 * GET /api/threads/:id -- one thread and all of its messages, oldest first.
 */
app.get('/api/threads/:id', (req, res) => {
  const thread = getThread(Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'No such thread.' });
  res.json(thread);
});

/**
 * POST /api/threads/:id/messages -- add a message to a thread.
 * Expects JSON: { body, parentId }
 *
 * parentId is optional. Including it makes the new message a reply to that one.
 */
app.post('/api/threads/:id/messages', (req, res) => {
  const threadId = Number(req.params.id);
  const { body, parentId } = req.body;

  const exists = db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId);
  if (!exists) return res.status(404).json({ error: 'No such thread.' });

  const bodyError = checkText(body, MAX_BODY, 'Message');
  if (bodyError) return res.status(400).json({ error: bodyError });

  // A reply must point at a message inside this same thread. Without this check
  // a reply could be attached to a message in someone else's thread entirely.
  let parent = null;
  if (parentId !== undefined && parentId !== null) {
    const found = db
      .prepare('SELECT id FROM messages WHERE id = ? AND thread_id = ?')
      .get(Number(parentId), threadId);

    if (!found) return res.status(400).json({ error: 'That message is not in this thread.' });
    parent = Number(parentId);
  }

  db.prepare(
    'INSERT INTO messages (thread_id, parent_id, body, created_at) VALUES (?, ?, ?, ?)'
  ).run(threadId, parent, body.trim().slice(0, MAX_BODY), new Date().toISOString());

  res.json(getThread(threadId));
});

/**
 * DELETE /api/threads/:id -- remove a whole thread and everything in it.
 *
 * Requires standing within NEARBY_METRES of the thread's pin.
 */
app.delete('/api/threads/:id', (req, res) => {
  const id = Number(req.params.id);

  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  if (!thread) return res.status(404).json({ error: 'No such thread.' });

  const tooFar = checkNearby(req.query, thread.lat, thread.lng);
  if (tooFar) return res.status(403).json({ error: tooFar });

  // Messages first: they refer to the thread, so removing the thread while its
  // messages still pointed at it would leave rows behind belonging to nothing.
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id);
  db.prepare('DELETE FROM threads WHERE id = ?').run(id);

  res.json({ threadDeleted: true, threadId: id });
});

/**
 * DELETE /api/messages/:id -- remove one message.
 *
 * Deleting requires standing within NEARBY_METRES of the thread. Anyone who is
 * there may delete anything in it, their own message or not -- with no accounts
 * there is no way to tell whose is whose. Being present is the only credential.
 *
 * What happens depends on whether anyone has replied:
 *
 *   Replies exist  -> the text is cleared and the message becomes a "[deleted]"
 *                     placeholder. Removing it outright would take everybody
 *                     else's replies down with it.
 *   No replies     -> the row is deleted properly. If that leaves its parent as
 *                     an empty placeholder, that goes too, and so on upwards.
 *
 * When a thread has nothing readable left, the thread and its pin are removed.
 */
app.delete('/api/messages/:id', (req, res) => {
  const id = Number(req.params.id);

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!message) return res.status(404).json({ error: 'No such message.' });

  const threadId = message.thread_id;

  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
  const tooFar = checkNearby(req.query, thread.lat, thread.lng);
  if (tooFar) return res.status(403).json({ error: tooFar });

  const replies = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ?')
    .get(id).n;

  if (replies > 0) {
    db.prepare("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  } else {
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    prunePlaceholders(message.parent_id);
  }

  // Is anything still readable in this thread?
  const left = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND deleted_at IS NULL')
    .get(threadId).n;

  if (left === 0) {
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    return res.json({ threadDeleted: true, threadId });
  }

  res.json(getThread(threadId));
});

/* -------------------------------------------------------------- helpers -- */

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

/**
 * Check that the requester is standing close enough to a place.
 *
 * The position arrives as ?lat=&lng= on the request. Returns an error string,
 * or null when they are near enough.
 */
function checkNearby(query, lat, lng) {
  const here = { lat: Number(query.lat), lng: Number(query.lng) };

  if (!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) {
    return 'This needs your location. Allow it and try again.';
  }

  const away = distanceInMetres(lat, lng, here.lat, here.lng);

  if (away > NEARBY_METRES) {
    return `You are ${Math.round(away)} m away. You can only do this within ${NEARBY_METRES} m.`;
  }

  return null;
}

/**
 * Walk up the chain of parents, clearing away placeholders that no longer hold
 * anything. Without this, deleting a reply and then its parent would leave
 * "[deleted]" markers behind for ever.
 */
function prunePlaceholders(parentId) {
  let id = parentId;

  while (id) {
    const parent = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!parent || parent.deleted_at === null) return;

    const replies = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ?')
      .get(id).n;
    if (replies > 0) return;

    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    id = parent.parent_id;
  }
}

/** Fetch a thread with its messages, or null if there is no such thread. */
function getThread(id) {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  if (!thread) return null;

  const messages = db
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC')
    .all(id);

  return { ...thread, messages };
}

/** Returns an error string, or null when the text is acceptable. */
function checkText(value, max, label) {
  if (typeof value !== 'string' || value.trim() === '') return `${label} is empty.`;
  if (value.trim().length > max) return `${label} is longer than ${max} characters.`;
  return null;
}

/* ---------------------------------------------------------------- start -- */

// '0.0.0.0' means "accept visitors from the network too", not just this laptop.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Threadstreet running at http://localhost:${PORT}\n`);
});
