// Prints the child-ask bindings variable as JSON; run under _hermetic-env.mjs by hermetic-env-bindings.test.ts.
process.stdout.write(JSON.stringify({ bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS ?? null }));
