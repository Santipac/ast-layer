#!/usr/bin/env node
// Single entry point: `mcp` starts the MCP server, everything else is the CLI.
import { main } from "./cli.js";
import { startMcpServer } from "./mcp.js";

const run = process.argv[2] === "mcp" ? startMcpServer() : main();
run.catch((e) => { console.error(`ast-layer: ${e.message}`); process.exitCode = 1; });
