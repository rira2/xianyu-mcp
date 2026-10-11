#!/usr/bin/env node
/** MCP stdio entry point. Clients run `node` with this file's installed path as `args`; see README.md
 * for the configuration block. Client-facing instructions are published below. */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { XianyuError } from './errors.ts';
import { getSession } from './browser.ts';
import { executeTool, OUTPUT_SCHEMA } from './response.ts';
import { TOOLS } from './tools.ts';

    // Read the handshake version from package.json to keep it in sync with releases. This path works
    // from both src/ and dist/, and npm includes package.json in the published package.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const mcp = new McpServer({ name: 'xianyu', version }, {
  instructions: 'Read-only public Xianyu/Goofish tools; no account or login is required. Check ok and status on every response: empty is a confirmed answer, partial retains validated cards, and error has diagnostics and retry_after_s. Listings are in data.items; numeric fields are under typed. Every response names its build and implementation fingerprint. Use capabilities with probe:false for fast limits and build checks. Search filters run on fetched cards; inspect diagnostics and observation ages before relying on results.',
});

for (const t of TOOLS) {
  mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema, outputSchema: OUTPUT_SCHEMA }, async (args: any) => {
    // DOM tools lock the shared navigating page in tools.ts. Mtop-only calls remain concurrent so a
    // slow search does not block feed requests.
    const envelope = await executeTool(t, args);
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: !envelope.ok };
  });
}

// The SDK's default validation errors contain only plain text. Route calls through the
// same validator as execution errors so bad arguments also have the published schema.
mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find(t => t.name === request.params.name) ?? {
    name: request.params.name, schema: {}, run: async () => { throw new XianyuError(`Unknown tool: ${request.params.name}`); },
  };
  const envelope = await executeTool(tool, request.params.arguments ?? {});
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: !envelope.ok };
});

    // Warm the browser in the background so the first tool call does not pay the cold-load delay.
    // Session.warmUp uses a separate page and is intentionally not awaited.
void getSession().warmUp().catch(() => {});

if (process.stdin.isTTY) {
  process.stderr.write('xianyu-mcp is an MCP stdio server and cannot be used interactively.\nConfigure it in an MCP client instead (see README.md).\n');
  process.exit(2);
}
const transport = new StdioServerTransport();
    // stdin may emit both end and close. Ignore the second shutdown call so it cannot exit while
    // browser.close() is still running.
let closing = false;
const shutdown = (code: number): void => {
  if (closing) return;                 // a teardown is already running and will exit when it is done
  closing = true;
  void getSession().shutdown().catch(() => {}).finally(() => process.exit(code));
};
transport.onclose = () => shutdown(0);
// The stdio transport does not handle stdin's end event, so close the browser when the client exits.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(signal, () => shutdown(0));
// The exit hook cannot await teardown; kill Chromium synchronously if the process exits unexpectedly.
process.on('exit', () => { getSession().killBrowser(); });
await mcp.connect(transport);
