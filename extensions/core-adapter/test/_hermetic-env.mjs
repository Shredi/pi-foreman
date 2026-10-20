// Preload for test:node (node --import): a session opened by `foreman session open` carries the parent env; the tests set their own.
delete process.env.PI_FOREMAN_HANDOFF_DIR;
delete process.env.PI_FOREMAN_PARENT_INTERCOM;
