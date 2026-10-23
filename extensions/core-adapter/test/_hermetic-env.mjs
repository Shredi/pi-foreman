// Preload for test:node (node --import): a session opened by `foreman session open` carries the parent env; the tests set their own.
delete process.env.PI_FOREMAN_HANDOFF_DIR;
delete process.env.PI_FOREMAN_PARENT_INTERCOM;
// A runner inside a Herdr pane must not hand its pane to the adapters under test: their presence files would name it.
for (const k of Object.keys(process.env)) if (k.startsWith("HERDR_")) delete process.env[k];
