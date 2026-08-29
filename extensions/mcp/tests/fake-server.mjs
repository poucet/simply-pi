/**
 * A minimal MCP stdio server for the wiring test: JSON-RPC over newline
 * delimited JSON, enough of the protocol for `McpClient.connect()` +
 * `listTools()`. The number of tools it exposes comes from argv[2], and a
 * `--slow <ms>` delays the initialize response so the "connecting" state is
 * observable.
 */

const toolCount = Number(process.argv[2] ?? 1);
const slowIndex = process.argv.indexOf("--slow");
const slowMs = slowIndex === -1 ? 0 : Number(process.argv[slowIndex + 1] ?? 0);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
	}
});

function handle(message) {
	if (message.id === undefined) return; // notification
	if (message.method === "initialize") {
		const reply = () =>
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "fake", version: "0" },
				},
			});
		if (slowMs > 0) setTimeout(reply, slowMs);
		else reply();
		return;
	}
	if (message.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				tools: Array.from({ length: toolCount }, (_, i) => ({
					name: `tool_${i}`,
					description: `fake tool ${i}`,
					inputSchema: { type: "object", properties: {} },
				})),
			},
		});
		return;
	}
	send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not implemented" } });
}
