import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

export interface RotatingLogOptions {
  maxBytes?: number;
  retainedFiles?: number;
}

export class RotatingLogStream extends Writable {
  private size: number;
  private readonly maxBytes: number;
  private readonly retainedFiles: number;

  constructor(private readonly file: string, options: RotatingLogOptions = {}) {
    super();
    this.maxBytes = options.maxBytes ?? 5_000_000;
    this.retainedFiles = options.retainedFiles ?? 3;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (this.size > 0 && this.size + buffer.length > this.maxBytes) {
        this.rotate();
      }
      fs.appendFileSync(this.file, buffer, { mode: 0o600 });
      this.size += buffer.length;
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private rotate(): void {
    for (let index = this.retainedFiles; index >= 1; index -= 1) {
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`;
      const destination = `${this.file}.${index}`;
      if (!fs.existsSync(source)) {
        continue;
      }
      if (index === this.retainedFiles && fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      }
      fs.renameSync(source, destination);
    }
    this.size = 0;
  }
}
