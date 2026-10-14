#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { startServer } from "../server/start.js";

const program = new Command()
  .name("agent-memory")
  .description("Local-first search service for coding-agent sessions and memories.")
  .version("0.0.0");

program
  .command("serve")
  .description("Run the local HTTP, MCP, and web server in the foreground.")
  .option("--host <host>", "loopback host", process.env.AGENT_MEMORY_HOST ?? "127.0.0.1")
  .option(
    "--port <port>",
    "listening port",
    (value) => {
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new InvalidArgumentError("port must be an integer between 1 and 65535");
      }
      return port;
    },
    Number.parseInt(process.env.AGENT_MEMORY_PORT ?? "43110", 10),
  )
  .option("--data-dir <path>", "application data directory")
  .action(async (options: { dataDir?: string; host: string; port: number }) => {
    await startServer({
      dataDirectory: options.dataDir,
      host: options.host,
      port: options.port,
    });
  });

await program.parseAsync();
