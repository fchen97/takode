import { escapeRegExp } from "./cli-launcher-codex-config-utils.js";

export function mergePathStrings(paths: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const pathValue of paths) {
    for (const entry of (pathValue || "").split(":")) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(":");
}

export function normalizeMaiHostname(input: string): string {
  let normalized = input.replace(/[^A-Za-z0-9._-]/g, "-");
  while (normalized.length > 0 && /^[._-]/.test(normalized)) normalized = normalized.slice(1);
  while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  if (normalized.length > 64) {
    normalized = normalized.slice(0, 64);
    while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  }
  return normalized || "host";
}

export function quoteShellEnvValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function readShellEnvAssignment(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, "m"));
  if (!match) return undefined;
  const value = match[1]?.trim() || "";
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\\\''/g, "'");
  }
  return value;
}
