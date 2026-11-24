# Page server

> Covers the per-machine page server that serves the harness pages (plan, note, result and brief pages) over HTTP: the URL shape, the keys, the threat statement for a network address, WSL, rotation, remote sessions and the fallback.
> Read it when a page link does not open, or before you set a network address or a base URL.
> The pages themselves (what they hold, how they are written) are in [herdr](herdr.md#pages); the dialogs that show the links are in [ceremony](ceremony.md).

One small background server per machine serves the pages the harness writes, so a page link opens in the browser you use: on this machine, in a Windows browser when Pi runs under WSL, and on a phone over your VPN when you set an address. It is a separate process (`foreman pages serve`), not part of Pi. A Pi session or the herdr-app Agents mod starts it the first time a link is needed (`foreman pages ensure`); every later session reuses it. It stops by itself after 12 hours with no request and no new page folder, and within a minute when `pages.server.enabled` is false.

## What is served

- **Page folders.** A session's show `pages/` folder (`<scratch dir>/show/<session id>/pages/`: `plan.html`, `note-<n>.html`, `result.html`) and the files it links to by relative path.
- **Briefs.** The brief file of a session-open dialog, only when its real path ends in `.md` or `.txt`. A markdown brief comes back as an HTML page rendered by the same renderer as the plan page; a `.txt` brief is served as text.
- **Click to enlarge.** Every HTML page it sends (plan, note, result and markdown brief pages) gets a small style and script added at serve time: a click on a picture or diagram opens it full window (wheel or pinch to zoom, drag to pan, Esc, the close button or a click outside closes). The stored files are not changed. The herdr-app slot copy, used when the server is off or the session is remote, has no zoom.
- **Nothing else.** The server lists no folder, writes nothing and serves only what a session registered. Allowed file types: `.html`, `.md` (rendered), `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.css`, `.txt`, up to 8 MiB; anything else is "not found". A file must be a regular file with one hard link, opened without following a symlink, and its real path must stay inside its registered folder.

## URL shape and secrets

A link is `<base>/<id>/<path>`: `<base>` is `pages.server.baseUrl` when set, else `http://<address>:<port>` of the local end the health check connected to and verified (`127.0.0.1` for the default bind, `[::1]` for bind `::1`, and for `localhost` whichever address it resolves to; IPv6 in brackets). A verified address that is not loopback, without a `baseUrl`, gives a file link; `<id>` is a random 128-bit secret (26 lowercase base32 characters, `[a-z2-7]`), one per registered folder or brief; `<path>` is the file below it (a brief: its file name). The secret in the path keeps relative links between the files of one folder working. A request without a known secret, a wrong method (only GET and HEAD), a path with `..`, `.`, a leading dot, `\`, `:` or NUL, a `Host` header that is not this machine (`127.0.0.1`, `localhost`, `[::1]`, the bind address or the `baseUrl` host; this closes DNS rebinding) all get "not found".

Every answer carries `Content-Security-Policy: sandbox allow-scripts allow-popups` (the page runs with an opaque origin: no browser storage, no read of another page), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

The secrets live in `<agent dir>/pi-foreman/state/pages/roots/<id>.json` (mode 0600, folder 0700). A folder unused for 7 days is dropped and its old links show "not found". The state folder is covered by the `selfmod-state-read` rule, so a child session cannot read it.

## Where links appear

Served links appear in UI lines only, never in a tool result, a project file or anything the model reads:

- the checkpoint notify line and the dialog link ("The page is served by this machine's page server.");
- one notify line after `foreman_show` (`Note page: <url>`); the tool result text stays as it was;
- the brief link of the `foreman session open` dialog;
- the herdr-app Plan panel: a click on a page of a local session runs `foreman pages url <page file>` and opens the URL it prints.

Under a clickable link the dialog's dim line still shows the file link. An agent that runs `foreman pages url <page file>` itself sees the URL of that one page in its tool result; the command answers only for a page file of a show `pages/` folder (see Threat statement).

## Keys

| Key | Default | Layers |
|---|---|---|
| `pages.server.enabled` | `true` | any layer; a project or session layer can only set `false` |
| `pages.server.port` | `47317` | user and overlay only |
| `pages.server.bind` | `"127.0.0.1"` | user and overlay only |
| `pages.server.baseUrl` | `""` | user and overlay only |

The server reads only the defaults, overlay and user layers (one server per machine, no project layer), at start and again every 60 seconds. It exits when `enabled` is false or when `port` or `bind` differ from the values it started with; the next link starts a new one. A changed `baseUrl` applies without a restart. Without Python, with a `defaults`-only result or with any config error (for example an unreadable user `foreman.json`) the server does not start, so a user's `enabled: false` is never ignored.

If another program holds the port, the server takes a free port (the port of its last run when that is free, so links survive a restart) and links use it. When `baseUrl` is set and the server had to take another port, no served links are made until the port is free: the links stay file links, and `foreman pages status` and `/foreman doctor` say why. A non-loopback `bind` with an empty `baseUrl` gives file links too, and `/foreman doctor` says so. A specific LAN address is not reachable on loopback. A wildcard bind (`0.0.0.0`, `::`) is, but the server does not hold the loopback address exclusively: another local process can bind that port on `127.0.0.1` or `::1` later and would receive the links. A `baseUrl` with a loopback bind is allowed, for a proxy or VPN forwarder in front.

## Restarts after an update

The server records a `build` in its state file and health answer: a short sha256 over the bytes of its own source files (the page server, the `foreman pages` command and every local module they import). A session that finds a healthy server of another build replaces it only when its own files are newer than that server's start, so an updated install replaces an old server and an older install never displaces a newer one. The server of another build is ended only by the pid its verified health answer gives; a record that does not answer, or answers without a valid proof, is never killed.

The health answer is authenticated by challenge and response. The client asks `GET /_health/<nonce>` with a fresh random nonce; the server answers its pid, version, build, port, bind and the local socket address and port it saw for this request (IPv4-mapped IPv6 shown as plain IPv4) plus `proof`, the HMAC-SHA256 under a health key it wrote to `server.json` (mode 0600) over the nonce and all of those fields. The client accepts the answer only when the proof verifies over exactly those fields, the answered local address and port equal the address and port it connected to (`localhost` resolved the way the client connects), and the answered pid equals the pid in `server.json`; the key itself is never sent. A relay that listens on loopback and forwards to a wildcard-bound server over another address therefore fails, because the real server sees that other address. A program that merely listens on the recorded port cannot answer correctly, so no link points at it, no health key reaches it and no pid it names is signalled. A server whose `server.json` no longer names its own pid, or whose `server.json` was deleted, ends itself at the next periodic check. A fresh server gets 5 s to start answering.

## Network address for a phone

Set both in your own user config (never in a repository):

```json
{ "pages": { "server": { "bind": "100.64.0.5", "baseUrl": "http://my-host.tailnet.example:47317" } } }
```

`bind` is the address the server listens on (`0.0.0.0` for all); `baseUrl` is how the phone reaches it and is written into every link. A non-loopback `bind` is the opt-in; the server writes one line naming the address to its log file at start.

### Threat statement for a network address

- Anyone who sees one link can read that page folder until you rotate the secrets. Pages hold plans, notes and briefs, which may quote code and paths.
- A note page written by the model (`foreman_show` with `html`) may run scripts with network access, as it does from a file. Such a script can send its own link and content out.
- The server speaks plain HTTP. Use it only over your VPN, never on an open network.
- A browser that syncs its history uploads the links with their secrets.
- An agent can ask the harness for the link of an existing page (`foreman pages url <page file>`). It then sees that one link. It can also rotate the secrets or stop the server, which breaks your open links but shows nothing.

On the loopback address only users and browser pages on this machine can try to connect; the secret in the path and the `Host` check keep another local user or a web page in your browser from guessing a link.

## WSL

Under WSL a Windows browser reaches the server through WSL's localhost forwarding (the default in NAT and mirrored mode): the link `http://127.0.0.1:<port>/...` opens in Windows. If you switched forwarding off in your WSL settings, the link does not open; set the key `pages.server.enabled` to `false` to get file links back.

## Remote sessions

A session on a remote machine (`PI_FOREMAN_REMOTE_PARENT=1` or `SSH_CONNECTION` set) keeps file links, because a loopback link would point at the wrong machine, unless that machine has its own `pages.server.baseUrl` set. The herdr-app plan mod asks `foreman pages url` for local sessions only; a remote session's page is copied and opened as before.

## Fallback

When the server is off (`enabled: false`), cannot start, the config call fails, the port is taken while `baseUrl` is set, or the session is remote without a `baseUrl`, links stay exactly what they were: a `file://` link in the dialogs and the notify line ("a path on this session's machine"), the slot copy in the herdr-app plan mod. A failed start is remembered for 60 seconds, so a link never waits twice in a minute.

## Commands

| Command | What it does |
|---|---|
| `foreman pages ensure` | starts the server when it is not running (reuses a running server; restarts it only when its build differs from this install and this install's files are newer than the server's start); prints the port, exits 1 when the server is off or did not start |
| `foreman pages url <path>` | prints the served URL of a page file; only a page file of a show `pages/` folder (`.../show/<session id>/pages/<plan\|result\|note-N>.html`, a regular file, no symlink); anything else prints nothing and exits 1 |
| `foreman pages status` | the server's pid, port, bind, version and roots, and why links are file links when they are |
| `foreman pages stop` | asks the server to exit |
| `foreman pages rotate` | deletes every secret: all old links stop working, the next link registers anew |
| `foreman pages serve` | the server itself (started by `ensure`; run it by hand only to debug) |

## Rotation and logs

`foreman pages rotate` is the way to cut off a leaked link. The server keeps no request log, because each request path carries a secret; its log file (`<agent dir>/pi-foreman/state/pages/server.log`) holds start, bind and exit lines only.

## Limits

- With no Pi session and no herdr-app running for 12 hours the server stops; old links then do not open until something starts it again.
- A served link is tied to the port, not to one server run. After the server stops (12-hour idle exit, `foreman pages stop`, reboot), and for up to 60 seconds through the session's ensure cache, an old link clicked while another local process holds the port sends that process the root id (ids live 7 days). This needs a hostile local process; on WSL a Windows-side process can play that role. Changing this is an owner trade-off left for later.
- A page folder is registered when its link is first made; a link from before a rotation or a 7-day drop shows "not found".
- The page server is not a general web server: no directory index, no uploads, no other methods.

Known limits, left for later:

- A bind to a scoped IPv6 address (`fe80::1%en0`) fails closed: the health check cannot verify it, so links stay file links.
- With bind `0.0.0.0`, a program squatting the same port on loopback makes `ensure` find no healthy server and start a second one on a free port; the first server keeps running until its 60-second config recheck ends it as an orphan.
