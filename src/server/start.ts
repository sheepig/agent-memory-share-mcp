import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildServer } from "./app.js";
import { getDataDirectory, isLoopbackHost } from "./paths.js";

export interface StartServerOptions {
  dataDirectory?: string;
  host: string;
  port: number;
}

export async function startServer(options: StartServerOptions): Promise<void> {
  if (!isLoopbackHost(options.host)) {
    throw new Error(`Refusing to listen on non-loopback host: ${options.host}`);
  }

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const app = await buildServer({
    dataDirectory: getDataDirectory(options.dataDirectory),
    publicDirectory: path.resolve(moduleDirectory, "../public"),
  });

  const shutdown = async () => {
    await app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.listen({ host: options.host, port: options.port });
}
