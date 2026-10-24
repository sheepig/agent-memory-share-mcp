import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

import pino, { type Logger } from "pino";
import { createStream } from "rotating-file-stream";

const MAX_FILE_BYTES = 5_000_000;
const MAX_RECORD_BYTES = 65_536;
const RETAINED_FILES = 3;

export interface FileLogger {
  logger: Logger;
  close(): Promise<void>;
}

export async function createFileLogger(file: string): Promise<FileLogger> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let index = 0; index <= RETAINED_FILES; index += 1) {
    const existing = index === 0 ? file : `${file}.${index}`;
    if (fs.existsSync(existing) && fs.statSync(existing).size > MAX_FILE_BYTES) fs.unlinkSync(existing);
  }
  const destination = createStream((index) => index ? `${file}.${index}` : file, {
    // The library rotates after a complete record; reserve space for the largest allowed record.
    size: `${MAX_FILE_BYTES - MAX_RECORD_BYTES}B`,
    rotate: RETAINED_FILES,
    mode: 0o600,
  });
  await once(destination, "open");
  const logger = pino({
    level: "info",
    serializers: {
      req(request: { method?: string; remoteAddress?: string; url?: string }) {
        return { method: request.method, remoteAddress: request.remoteAddress, url: request.url?.split("?", 1)[0] };
      },
    },
    hooks: {
      streamWrite(record) {
        const bytes = Buffer.byteLength(record);
        return bytes <= MAX_RECORD_BYTES ? record : `${JSON.stringify({
          level: 40, time: Date.now(), msg: "Oversized log record omitted.", bytes,
        })}\n`;
      },
    },
  }, destination);
  let closing: Promise<void> | undefined;
  return {
    logger,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      destination.end((error?: Error | null) => error ? reject(error) : resolve());
    }),
  };
}
