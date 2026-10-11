#!/usr/bin/env node
/** MCP stdio entry point. Clients run `node` with this file's installed path as `args`; see README.md
 * for the configuration block. Client-facing instructions are published below. */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getSession } from './browser.ts';
import { describe } from './errors.ts';
import { TOOLS } from './tools.ts';

    // Read the handshake version from package.json to keep it in sync with releases. This path works
    // from both src/ and dist/, and npm includes package.json in the published package.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const mcp = new McpServer({ name: 'xianyu', version }, {
  instructions: 'Read-only access to Xianyu/Goofish with NO Xianyu account required. Start with search_items for a keyword, then item_view for the listings worth a closer look. search_items returns cards (price, want count, seller, city, tags); detail=N on search_items or item_view fills in description, photos, seller sales and shipping. Calls run one at a time on the browser, except the mtop-only tools (browse_feed, search_count, related_items, seller_profile, seller_items), which run alongside. Call capabilities to see the current state and the build that is answering.',
});

for (const t of TOOLS) {
  mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: any) => {
    // DOM tools lock the shared navigating page in tools.ts. Mtop-only calls remain concurrent so a
    // slow search does not block feed requests.
    let envelope: any;
    try {
      envelope = { ok: true, version, data: await t.run(args) };
    } catch (e) {
      envelope = { ok: false, version, ...describe(e) };
    }
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope };
  });
}

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
  void getSession().close().catch(() => {}).finally(() => process.exit(code));
};
transport.onclose = () => shutdown(0);
// The stdio transport does not handle stdin's end event, so close the browser when the client exits.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(signal, () => shutdown(0));
// The exit hook cannot await teardown; kill Chromium synchronously if the process exits unexpectedly.
process.on('exit', () => { getSession().killBrowser(); });
await mcp.connect(transport);
