import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverFileSteps } from "./file-discovery.js";

const temporaryDirectories: string[] = [];
const options = { extensions: new Set([".jsonl"]), onDiagnostic() {} };
const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-file-discovery-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("incremental file discovery", () => {
  it("resumes a stable path cursor after deletion and mtime changes, including punctuation and directory cursors", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "a"));
    for (const name of ["a.jsonl", "a/child.jsonl", "b.jsonl"]) await fs.writeFile(path.join(root, name), "{}");
    const steps = await collect(discoverFileSteps([root], options));
    const cursors = steps.flatMap((step) => step.cursor ? [step.cursor] : []);
    expect(cursors).toEqual([...cursors].sort());
    for (let index = 0; index < cursors.length; index += 1) {
      const resumed = await collect(discoverFileSteps([root], { ...options, after: cursors[index] }));
      expect(resumed.flatMap((step) => step.cursor ? [step.cursor] : [])).toEqual(cursors.slice(index + 1));
    }
    await fs.rm(path.join(root, "a.jsonl"));
    await fs.utimes(path.join(root, "b.jsonl"), 0, 0);
    const resumed = await collect(discoverFileSteps([root], { ...options, after: path.join(root, "a.jsonl") }));
    expect(resumed.flatMap((step) => step.file ? [path.relative(root, step.file)] : [])).toEqual(["a/child.jsonl", "b.jsonl"]);
  });

  it("does not declare a directory-limited scan complete and resumes from the last checked path", async () => {
    const root = await makeRoot();
    for (const name of ["a", "b", "c"]) {
      await fs.mkdir(path.join(root, name));
      await fs.writeFile(path.join(root, name, "session.jsonl"), "{}");
    }
    const limited = await collect(discoverFileSteps([root], { ...options, maxDirectories: 2 }));
    expect(limited.at(-1)).toEqual({ complete: false });
    const lastCursor = limited.flatMap((step) => step.cursor ? [step.cursor] : []).at(-1);
    const resumed = await collect(discoverFileSteps([root], { ...options, maxDirectories: 2, after: lastCursor }));
    expect(resumed.some((step) => step.file === path.join(root, "b/session.jsonl"))).toBe(true);
  });

  it("advances through empty, unsupported, and symbolic link entries without reading link targets", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "empty"));
    await fs.writeFile(path.join(root, "other.txt"), "private content");
    await fs.symlink(path.join(root, "other.txt"), path.join(root, "linked.jsonl"));
    const steps = await collect(discoverFileSteps([root], options));
    expect(steps.filter((step) => step.file)).toEqual([]);
    expect(steps.flatMap((step) => step.cursor ? [path.relative(root, step.cursor)] : [])).toContain("linked.jsonl");
    expect(steps.some((step) => step.cursor === path.join(root, "empty") + path.sep)).toBe(true);
  });
});
