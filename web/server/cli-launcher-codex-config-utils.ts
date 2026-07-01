import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getSelectedProviderEnvKeys(configToml: string): string[] {
  const provider = readTopLevelStringSetting(configToml, "model_provider")?.trim();
  if (!provider) return [];
  const envKey = readStringSettingInSection(configToml, `[model_providers.${provider}]`, "env_key")?.trim();
  return envKey ? [envKey] : [];
}

export function usesMaiLitellmProvider(configToml: string): boolean {
  return readTopLevelStringSetting(configToml, "model_provider")?.trim().toLowerCase() === "mai-litellm";
}

export function resolveConfigPathValue(configDir: string, rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return join(homedir(), rawPath.slice(2));
  }
  return resolve(configDir, rawPath);
}

export function coercePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function mergeUniqueStrings(existing: string[], additions: string[]): string[] {
  const merged = [...existing];
  for (const value of additions) {
    if (!merged.includes(value)) merged.push(value);
  }
  return merged;
}

function extractQuotedStrings(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    out.push(match[1].replace(/\\"/g, '"'));
  }
  return out;
}

function renderIncludeOnlyArray(vars: string[]): string[] {
  return ["include_only = [", ...vars.map((v) => `    "${v}",`), "]"];
}

export function removeTopLevelTomlSettings(configToml: string, keys: Set<string>): string {
  if (keys.size === 0 || !configToml.trim()) return configToml;

  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: string[] = [];
  let inRoot = true;
  let skipUntilMultilineDelimiter: '\"\"\"' | "'''" | null = null;

  for (const line of lines) {
    if (skipUntilMultilineDelimiter) {
      if (line.includes(skipUntilMultilineDelimiter)) {
        skipUntilMultilineDelimiter = null;
      }
      continue;
    }

    const trimmed = line.trim();
    if (/^\[\[?.+\]\]?\s*(?:#.*)?$/.test(trimmed)) {
      inRoot = false;
      out.push(line);
      continue;
    }

    const assignment = inRoot ? line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/) : null;
    const key = assignment?.[1];
    if (!key || !keys.has(key)) {
      out.push(line);
      continue;
    }

    const valueStart = line.slice(line.indexOf("=") + 1).trimStart();
    const delimiter = valueStart.startsWith('\"\"\"') ? '\"\"\"' : valueStart.startsWith("'''") ? "'''" : null;
    if (delimiter && !valueStart.slice(delimiter.length).includes(delimiter)) {
      skipUntilMultilineDelimiter = delimiter;
    }
  }

  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

export function upsertShellEnvironmentIncludeOnly(configToml: string, requiredVars: string[]): string {
  if (requiredVars.length === 0) return configToml;
  const shellEnvPolicyHeader = "[shell_environment_policy]";
  const normalizedRequired = Array.from(new Set(requiredVars)).sort();
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === shellEnvPolicyHeader.toLowerCase());
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(shellEnvPolicyHeader);
    out.push(...renderIncludeOnlyArray(normalizedRequired));
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let includeStart = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (/^\s*include_only\s*=\s*\[/.test(lines[i])) {
      includeStart = i;
      break;
    }
  }

  if (includeStart === -1) {
    const out = [...lines];
    out.splice(sectionStart + 1, 0, ...renderIncludeOnlyArray(normalizedRequired));
    return out.join("\n") + (endsWithNewline ? "\n" : "");
  }

  let includeEnd = includeStart;
  while (includeEnd < sectionEnd) {
    if (lines[includeEnd].includes("]")) break;
    includeEnd++;
  }
  if (includeEnd >= sectionEnd) includeEnd = includeStart;

  const includeBlock = lines.slice(includeStart, includeEnd + 1).join("\n");
  const existingVars = extractQuotedStrings(includeBlock);
  const mergedVars = mergeUniqueStrings(existingVars, normalizedRequired);
  const replacement = renderIncludeOnlyArray(mergedVars);
  const out = [...lines];
  out.splice(includeStart, includeEnd - includeStart + 1, ...replacement);
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upsertBooleanSettingInSection(
  configToml: string,
  sectionHeader: string,
  key: string,
  value: boolean,
): string {
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === sectionHeader.toLowerCase());
  const renderedLine = `${key} = ${value ? "true" : "false"}`;
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(sectionHeader);
    out.push(renderedLine);
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const keyIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line),
  );

  const out = [...lines];
  if (keyIndex === -1) {
    out.splice(sectionStart + 1, 0, renderedLine);
  } else {
    out[keyIndex] = renderedLine;
  }
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

export function upsertTopLevelNumberSetting(configToml: string, key: string, value: number): string {
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const renderedLine = `${key} = ${Math.floor(value)}`;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let insertAt = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      insertAt = i;
      break;
    }
    if (keyPattern.test(lines[i])) {
      const out = [...lines];
      out[i] = renderedLine;
      return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
    }
  }

  const out = [...lines];
  out.splice(insertAt, 0, renderedLine);
  return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
}

function readTomlStringValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\\\''/g, "'");
  }
  return value;
}

export function readTopLevelStringSetting(configToml: string, key: string): string | undefined {
  const lines = configToml.split("\n");
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);

  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = line.match(keyPattern);
    if (match?.[1]) return readTomlStringValue(match[1]);
  }

  return undefined;
}

export function readStringSettingInSection(configToml: string, sectionHeader: string, key: string): string | undefined {
  const lines = configToml.split("\n");
  const normalizedHeader = sectionHeader.trim().toLowerCase();
  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === normalizedHeader);
  if (sectionStart === -1) return undefined;

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = lines[i].match(keyPattern);
    if (match?.[1]) return readTomlStringValue(match[1]);
  }

  return undefined;
}

export function readTopLevelNumberSetting(configToml: string, key: string): number | undefined {
  const lines = configToml.split("\n");
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`);

  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = line.match(keyPattern);
    if (!match?.[1]) continue;
    const value = Number(
      match[1]
        .replace(/\s+#.*$/, "")
        .replace(/_/g, "")
        .trim(),
    );
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }

  return undefined;
}

export function upsertTopLevelStringSetting(configToml: string, key: string, value: string): string {
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const renderedLine = `${key} = ${JSON.stringify(value)}`;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let insertAt = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      insertAt = i;
      break;
    }
    if (keyPattern.test(lines[i])) {
      const out = [...lines];
      out[i] = renderedLine;
      return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
    }
  }

  const out = [...lines];
  out.splice(insertAt, 0, renderedLine);
  return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
}
