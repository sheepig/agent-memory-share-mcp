const linePatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  { label: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu },
  { label: "database credential URL", pattern: /\b(?:mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/iu },
  { label: "Git provider token", pattern: /\b(?:gh[pousr]_|github_pat_|glpat-|box_)[A-Za-z0-9_-]{16,}/u },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { label: "labelled secret", pattern: /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*["']?[^\s"']{12,}/iu },
];

export const SENSITIVE_CONTENT_RULE_VERSION = 2;

const entropyCandidate = /\b[A-Za-z0-9_+/=-]{32,160}\b/gu;
const builtInAllowedValues = [
  /^[a-f0-9]{32,128}$/iu,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  /^(.)\1{31,}$/u,
];

export interface SensitiveTextResult {
  findings: string[];
  text: string;
}

export interface SensitiveTextOptions {
  allow?: RegExp[];
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  return [...frequencies.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function containsHighEntropySecret(line: string, allow: RegExp[]): boolean {
  for (const match of line.matchAll(entropyCandidate)) {
    const value = match[0];
    if ([...builtInAllowedValues, ...allow].some((pattern) => pattern.test(value))) continue;
    const mixed = /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /[0-9]/u.test(value);
    if (mixed && shannonEntropy(value) >= 4.3) return true;
  }
  return false;
}

export function redactSensitiveText(value: string, options: SensitiveTextOptions = {}): SensitiveTextResult {
  const findings = new Set<string>();
  const lines: string[] = [];
  let privateKey = false;
  for (const line of value.split("\n")) {
    if (/-----BEGIN .*PRIVATE KEY-----/u.test(line)) {
      privateKey = true;
      findings.add("private key");
    }
    const matches = linePatterns.filter(({ pattern }) => pattern.test(line));
    matches.forEach(({ label }) => findings.add(label));
    const highEntropy = containsHighEntropySecret(line, options.allow ?? []);
    if (highEntropy) findings.add("high-entropy token");
    lines.push(privateKey || matches.length > 0 || highEntropy ? "[credential-like content omitted]" : line);
    if (/-----END .*PRIVATE KEY-----/u.test(line)) privateKey = false;
  }
  return { findings: [...findings], text: lines.join("\n") };
}
