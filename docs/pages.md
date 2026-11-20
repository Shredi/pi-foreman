# Page server

> Covers the per-machine page server that serves the harness pages (plan, note and brief pages) over HTTP.
> Read it when a page link does not open, or before you set a network address or a base URL.
> Stub written with the server code; the full text (threat statement, WSL, rotation, remote sessions) follows with the link integration.

One small background server per machine serves the harness pages so a page link opens in the browser you use. It listens on `127.0.0.1` by default; each page folder has its own secret link. Keys: `pages.server.enabled`, `pages.server.port`, `pages.server.bind`, `pages.server.baseUrl`. When the server is off or cannot start, links stay file links. Commands: `foreman pages ensure|url|status|stop|rotate`.
