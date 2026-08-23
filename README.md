# Threadstreet

A map of conversations. Each pin is a thread anyone can join.

## Requirements

**Node.js 22.5 or newer** — that is all. The database is built into Node, so
there is nothing else to install or configure.

Check yours with `node --version`. Get it from [nodejs.org](https://nodejs.org).

## Run it

```bash
git clone https://github.com/sahakyanhk/threadstreet.git
cd threadstreet
npm install
npm start
```

Open **http://localhost:3000**. Stop it with `Ctrl-C`.

Use `npm run dev` instead while editing — it restarts on every file change.

That is the whole setup. No accounts, no API keys, no Docker, no cloud services.

## Using it

**Each pin on the map is a thread** — a place with a name. There are no
accounts, so being there is the only credential:

- **Anyone, anywhere** can read threads and write messages in them.
- **Only someone within 10 metres** of a spot can start a thread there, or
  delete a message or thread once it exists.

- **Tap an empty spot** and you are asked whether to start a thread there: a
  name, and a first message. This needs your location, and the spot must be
  within 10 m of you. Ten metres is only a few pixels wide at street zoom, so
  the dialog offers **“Put the pin where I am”** when your tap lands out of
  range — usually easier than tapping precisely.
- **Tap a pin** (or a thread in the list) and its history opens in a second
  panel, beside the list. Clicking the same row again closes that panel;
  clicking a different one switches to it. Closing the thread panel leaves the
  list open — the list has its own × for closing everything.
- **Add to a thread** with the box at the bottom of that panel. Writing and
  replying need no location at all, from anywhere in the world.
- **Reply to one message** with its Reply link — replies nest underneath.
- **Delete a whole thread** with the bin icon in its header. Every message in
  it goes, and its pin leaves the map. You must be within 10 m of it.
- **Delete a message** with its Delete link, again only from within 10 m. You are asked to confirm, and it
  cannot be undone. If anyone has replied, the message becomes a “Message
  deleted” placeholder so their replies stay where they are; otherwise it is
  removed outright. When a thread has nothing readable left, the thread and its
  pin disappear too.
- **The three dots, top left**, open the list of every thread. Account and
  settings will live in this panel later.
- **The target button, bottom right**, finds where you actually are and asks
  permission the first time. It only centres the map. It needs an `https://`
  address, so it works on `localhost` or through a tunnel, but not over a
  plain `http://` IP.
- **Zoom buttons** are in the bottom-left corner.

New threads and messages from other people appear within ten seconds.

## The files

```
server.js         The whole backend: serves the site, stores threads.
package.json      One dependency: Express.
messages.db       Created on first run. Delete it to wipe everything.

web/index.html    The page.
web/app.js        Everything the page does.
web/style.css     How it looks.

test/browser.mjs  The tests. Drives a real Chrome.
NOTES.md          Why things are the way they are, and where the traps are.
```

Six files. Read `server.js` first, then `web/app.js`.

The server only speaks JSON, and the website is just one thing that talks to it:

| Method | Path                        | What it does                  |
| ------ | --------------------------- | ----------------------------- |
| GET    | `/api/threads`              | Every thread, for the pins.    |
| POST   | `/api/threads`              | Start one: name, position, first message. |
| GET    | `/api/threads/:id`          | One thread and all its messages. |
| POST   | `/api/threads/:id/messages` | Add a message, or a reply.     |
| DELETE | `/api/messages/:id?lat=&lng=` | Delete a message. Must be within 10 m. |
| DELETE | `/api/threads/:id?lat=&lng=`  | Delete a thread and everything in it. Must be within 10 m. |

A message may carry a `parentId`, which makes it a reply to that message.

## Tests

```bash
npm test
```

Drives a real Chrome, on its own throwaway database, so your messages are left
alone. Needs Chrome or Chromium installed; nothing else.

Most of this app only exists once a browser is running it, so this is the check
that matters — run it after changing anything in `web/`.

## Letting other people try it (optional)

**Same wifi:** send them `http://<your-ip>:3000`. Find your IP with
`ipconfig getifaddr en0` on macOS, or `hostname -I` on Linux.

**Anyone else:** you need a public address pointing at your laptop. One free way,
in a second terminal while the server runs:

```bash
brew install cloudflared                        # once
cloudflared tunnel --url http://localhost:3000
```

It prints an address like `https://random-words.trycloudflare.com`. Send that to
anyone. Close the terminal and it disappears — nothing is left online, and there
is no account or bill. The address changes each time.

This is **only** for sharing. It is not needed to run the app.

> If that link fails to open for you but works for others, your router's DNS is
> blocking `trycloudflare.com`. Add `1.1.1.1` as your DNS, or test on mobile data.

## What it does not do

Deliberately, for now:

- **No accounts.** Anybody standing at a thread can delete anything in it,
  theirs or not — presence is the only credential. Nothing can be edited.
- **No limits.** One person could post a thousand messages.
- **No moderation.** Nothing filters what people write.
- **The 10 m rule is a rule, not a lock.** Positions are whatever the visitor's
  browser reports, and the delete endpoints simply believe the coordinates sent
  to them. Anyone willing to craft their own requests can claim to be anywhere.
  Making it real needs accounts and something the server can actually verify.
- **Nothing is owned.** With no accounts there is no way to tell whose message
  is whose, so deletion cannot be restricted to its author.
- **Every thread loads at once.** Fine for hundreds, not thousands.
- **Pins do not group.** A busy street becomes a pile of markers.

Fine for a handful of testers. Worth fixing before it is public.
