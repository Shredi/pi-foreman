// Stdio MCP server for the on-demand MCP child test (mcp-child.test.ts). Newline-delimited JSON-RPC 2.0, the framing
// Pi's stdio transport reads. argv[2] is a start marker written when the server starts; argv[3] is an exit marker
// written when stdin closes, so the test can tell the server was shut down. Two tools: `echo` and `shout`.
import * as fs from "node:fs";
import * as readline from "node:readline";

const [, , startMarker, exitMarker] = process.argv;
fs.writeFileSync(startMarker, "started\n");

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handlers = {
  initialize: (params) => ({
    protocolVersion: params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "fx", version: "0.0.0" },
  }),
  ping: () => ({}),
  "tools/list": () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the text argument back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        name: "shout",
        description: "Return the text argument in upper case.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ],
  }),
  "tools/call": (params) => ({
    content: [{ type: "text", text: params?.name === "shout" ? String(params?.arguments?.text ?? "").toUpperCase() : String(params?.arguments?.text ?? "") }],
    isError: false,
  }),
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  // Notifications carry no id and get no response.
  if (message.id === undefined) return;
  const handler = handlers[message.method];
  if (!handler) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: handler(message.params ?? {}) });
});
rl.on("close", () => {
  fs.writeFileSync(exitMarker, "exited\n");
  process.exit(0);
});
