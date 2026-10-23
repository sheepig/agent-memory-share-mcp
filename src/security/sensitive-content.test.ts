import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "./sensitive-content.js";

describe("redactSensitiveText", () => {
  it("redacts common credential forms without retaining their values", () => {
    const result = redactSensitiveText([
      "safe context",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "postgres://user:super-secret-password@localhost/database",
      "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
    ].join("\n"));

    expect(result.text).toContain("safe context");
    expect(result.text).not.toContain("super-secret-password");
    expect(result.findings).toEqual(expect.arrayContaining(["Bearer token", "database credential URL", "JWT"]));
  });

  it("redacts high-entropy mixed tokens while allowing hashes, UUIDs, and caller-approved values", () => {
    const secret = "B9mQ2vL7xR4pT8kN6sW3cF5hJ1zD0yUa";
    const hash = "a".repeat(64);
    const uuid = "3f5ad8ea-b580-4d2f-83aa-b16372b25a5b";
    const approved = "Z8yX7wV6uT5sR4qP3nM2kJ1hG9fD0cBa";
    const result = redactSensitiveText(`token ${secret}\nhash ${hash}\nuuid ${uuid}\napproved ${approved}`, {
      allow: [new RegExp(`^${approved}$`, "u")],
    });
    expect(result.findings).toContain("high-entropy token");
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(hash);
    expect(result.text).toContain(uuid);
    expect(result.text).toContain(approved);
  });
});
