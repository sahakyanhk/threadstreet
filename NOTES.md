# Notes for whoever works on this next

Context that is not obvious from reading the code, written for a person or an
assistant picking this up cold. `README.md` says what the project is and how to
run it; this file says *why it is the way it is*, and where the traps are.

Last updated: 2026-08-22.

---

## Who this is for

The owner is new to web development and is learning by building this. That
shapes how to work here:

- **Explain the mechanics, not just the fix.** Say what runs where and why a
  piece exists. Comment code with the reason, not a restatement of the syntax.
- **Prefer plain HTML, CSS and JavaScript with no build step.** A framework
  would hide exactly the machinery they are trying to see. This is a deliberate
  choice, not an oversight.
- **Introduce one new idea at a time.**
- **Update `README.md` as part of every change**, written for a stranger who has
  just cloned the repo. Docs drifting from the code makes it unusable to anyone
  else.
- **Keep chat replies short.** Explanation belongs in the README.

## Where it is going

Native iOS and Android apps are a stated goal. That is why `server.js` is a
plain JSON API that knows nothing about maps or screens, and `web/` is treated
as merely the first client. A phone app should be a second client of the same
API.

**Do not put rules in the frontend that a phone app would also need.** Anything
that matters must be enforced in `server.js`.

---

## Shape of the thing

```
server.js          Everything server-side: schema, migrations, routes.
web/index.html     Structure.
web/app.js         All browser behaviour.
web/style.css      Looks.
test/browser.mjs   The tests. Drives real Chrome.
messages.db        SQLite. Created on first run, git-ignored.
```

Deliberately few files, deliberately no build step, deliberately one dependency
(Express). Resist adding more without a concrete reason.

### Data model

- A **thread** is a named place: `title`, `lat`, `lng`, plus `creator_lat`,
  `creator_lng`, `creator_accuracy_m` recording where its creator was.
- A **message** belongs to a thread. `parent_id` pointing at another message
  makes it a reply. `deleted_at` marks a placeholder (see below).

### The rules, as they currently stand

| Action | Location needed | Limit |
| --- | --- | --- |
| Read | no | — |
| Write or reply | no | anywhere |
| Start a thread | yes | within 10 m of the spot |
| Delete a message | yes | within 10 m of its thread |
| Delete a thread | yes | within 10 m |

`NEARBY_METRES` is defined in both `server.js` and `web/app.js`. Change both.

---

## Traps, each of which cost real time

### `[hidden]` loses to any `display` rule you write

Browsers hide `[hidden]` elements with a built-in `display: none`, but **any
author rule outranks a built-in one**. Several panels set `display: flex`, which
silently cancelled `hidden` and left every panel and dialog on screen at once.

`web/style.css` now carries `[hidden] { display: none !important; }` near the
top. **It is load-bearing. Do not remove it.**

### Test real visibility, never `element.hidden`

The bug above sailed past a fully green test run, because the tests asserted
`element.hidden === true` — which was true, on an element sitting there plainly
visible. `.hidden` reports the attribute, not whether anything is displayed.

`test/browser.mjs` has a `visible()` helper checking `offsetParent` and the
element's box. Use it.

### Leaflet writes strings into `innerHTML`

`marker.bindTooltip(someString)` sets `innerHTML`. A thread named
`<img src=x onerror=...>` would have executed. Pass a DOM element with
`textContent` set instead — see `drawPin()`.

There is no `escapeHtml` anywhere any more, because everything is built with
`createElement` and `textContent`. **Keep it that way.** If you ever write a
template literal into `innerHTML`, you have reintroduced the problem.

### `openPopup()` cancels `flyTo()`

Opening a popup makes Leaflet pan to fit it, which interrupts a flight in
progress and strands the map partway. Open popups on `moveend` instead.

### Deleting must prune markers

`loadThreads()` adds pins for new threads *and* removes pins whose thread has
gone. Without the removal, deleted threads keep their pin until a page reload —
and other people's deletions never show at all.

### Two different "nearby" numbers

- **22 pixels** — tapping this close to an existing pin opens that thread
  instead of starting a new one. Screen-space, so it behaves sensibly at any
  zoom.
- **10 metres** — the real-world rule for creating and deleting.

They interact. At high zoom you can create threads 6 m apart; at low zoom a tap
near a pin opens it. This is intended, but it does surprise people.

### Ten metres is a few pixels

At zoom 16 (where the locate button lands you) 10 m is roughly two pixels. Nobody
can tap that accurately. The new-thread dialog therefore offers **"Put the pin
where I am"**, which snaps the pin onto the visitor's position. Without that
affordance the 10 m rule is effectively unusable — do not remove it lightly.

### Geolocation needs a secure context

Browsers hand out a location only on `https://` or `localhost`. Over a plain
`http://192.168.x.x` address the request is **refused with no prompt at all**,
which looks exactly like a broken button. `web/app.js` checks
`window.isSecureContext` first and says so.

This is why sharing over a tunnel matters for testing anything location-related.

### `node:sqlite` is experimental

The database is built into Node (22.5+), which is why there is nothing to
install. Node prints an experimental warning on start; that is expected. The API
could change in a future Node major version.

---

## Honest limits

These are known, deliberate, and should be stated plainly rather than papered
over:

- **The 10 m rule is a rule, not a lock.** Positions are whatever the visitor's
  browser reports, and the delete endpoints simply believe the coordinates in
  the query string. Anyone crafting their own requests can claim to be anywhere.
  Making it real needs accounts and something the server can actually verify.
- **No accounts.** Presence is the only credential, so anyone standing at a
  thread can delete anything in it, theirs or not.
- **No rate limiting, no moderation.** One script could fill the database.
- **Every thread loads at once.** Fine for hundreds, not thousands. The fix is
  to send only threads within the map's current view — the server would take a
  bounding box, and the page would re-ask on `moveend`.
- **Pins do not cluster.** A busy street becomes an unreadable pile.
- **Location accuracy is whatever the device gives.** On a laptop that is
  wifi-based, typically 20–100 m; there is no GPS to do better. See below.

## Things considered and deliberately not done

- **Hardening** (helmet, rate limiting, CORS allow-lists, security headers) was
  built and then **removed on purpose**, to keep the code readable while it is
  only being shown to a few people. It must come back before this is public.
- **Deployment** (Dockerfile, `fly.toml`, persistent-volume config) was likewise
  built and removed. The plan was Fly.io with a mounted volume, because SQLite
  needs a real disk that survives deploys — most cheap hosting wipes the
  filesystem on every deploy and would silently erase every thread. If you
  redo this: one machine only (`fly deploy --ha=false`), since two machines
  cannot share one volume.
- **`watchPosition` for better accuracy.** `getCurrentPosition` returns the
  first fix, which on a phone is usually the poor wifi estimate before GPS
  locks. `watchPosition` streams improving fixes; keep the best, stop at a
  target accuracy or a time budget, always `clearWatch`. Worth real gains on
  phones, near-none on desktop. Deferred until phone testing shows it is needed.

---

## Testing

```bash
npm test
```

Drives a real Chrome over the DevTools Protocol. No packages needed — Node has a
built-in WebSocket, and Chrome ships the protocol. It starts its own server on
port 3100 with a throwaway database, so your own data is untouched.

**Most of this app only exists once a browser runs it.** Testing the server
alone missed two real bugs that shipped. If you change anything in `web/`, run
this.

The suite also fails the run if the browser reports *any* console error, which
catches a class of breakage no assertion was written for.

Chrome is found by checking a list of standard install paths at the top of
`test/browser.mjs`; add yours if it is somewhere else.

## Sharing it while testing

```bash
npm run dev                                     # terminal 1
cloudflared tunnel --url http://localhost:3000  # terminal 2
```

Gives a public `https://` address that dies when you close the terminal.
Optional — not needed to run the app, only to let other people reach it.

One known snag: some routers' DNS refuses to resolve `trycloudflare.com`, so the
link may fail for you while working fine for everyone else. Setting DNS to
`1.1.1.1`, or testing on mobile data, gets around it.
