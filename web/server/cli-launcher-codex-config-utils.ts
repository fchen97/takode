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

const SHELL_ENV_POLICY_HEADER = "[shell_environment_policy]";
const SHELL_ENV_POLICY_SET_HEADER = "[shell_environment_policy.set]";

/**
 * The variables Codex passes to commands with `inherit = "core"` on Unix. Codex
 * versions differ slightly (older ones also pass USERNAME; newer ones the
 * locale variables), so this is the union.
 */
const CODEX_CORE_ENV_VARS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
];

/** Left in a session copy whose `inherit = "core"` or `"none"` Takode widened, so later launches know. */
const WIDENED_INHERIT_MARKER = /^\s*#\s*Takode: inherit was "(core|none)"/;

/**
 * Make Codex pass `requiredVars` to the commands it runs, and `inheritedVars`
 * too when the user's policy lets the environment through, keeping the rest of
 * the user's `[shell_environment_policy]`.
 *
 * Codex builds a command's environment in order: `inherit` picks the starting
 * variables, excludes drop some, `set` adds its own, then a non-empty
 * `include_only` keeps only matching names. So `include_only` cannot bring back
 * what `inherit = "core"` or `"none"` already dropped. For those, the session
 * copy inherits everything and `include_only` lists exactly what the user's
 * policy passed (the core variables, or none, plus `set`) together with
 * `requiredVars`; other variables, such as tokens, still stay out.
 */
export function upsertShellEnvironmentPolicy(
  configToml: string,
  requiredVars: string[],
  inheritedVars: string[] = [],
): string {
  const normalizedRequired = Array.from(new Set(requiredVars)).sort();
  const normalizedAll = Array.from(new Set([...requiredVars, ...inheritedVars])).sort();
  if (normalizedAll.length === 0) return configToml;
  const endsWithNewline = configToml.endsWith("\n");
  const lines = configToml.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const sectionStart = findSectionStart(lines, SHELL_ENV_POLICY_HEADER);
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(SHELL_ENV_POLICY_HEADER);
    out.push(...renderIncludeOnlyArray(normalizedAll));
    return out.join("\n") + (endsWithNewline || configToml.length === 0 ? "\n" : "");
  }
  const sectionEnd = findSectionEnd(lines, sectionStart);

  let includeStart = -1;
  let inheritLine = -1;
  let ignoreDefaultExcludesLine = -1;
  let widenedFrom: string | undefined;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const line = lines[i];
    if (includeStart === -1 && /^\s*include_only\s*=\s*\[/.test(line)) includeStart = i;
    if (inheritLine === -1 && /^\s*inherit\s*=/.test(line)) inheritLine = i;
    if (ignoreDefaultExcludesLine === -1 && /^\s*ignore_default_excludes\s*=/.test(line)) {
      ignoreDefaultExcludesLine = i;
    }
    widenedFrom ??= line.match(WIDENED_INHERIT_MARKER)?.[1];
  }
  let includeEnd = includeStart;
  if (includeStart !== -1) {
    while (includeEnd < sectionEnd && !lines[includeEnd].includes("]")) includeEnd++;
    if (includeEnd >= sectionEnd) includeEnd = includeStart;
  }
  const existingVars =
    includeStart === -1 ? [] : extractQuotedStrings(lines.slice(includeStart, includeEnd + 1).join("\n"));
  const inherit =
    inheritLine === -1 ? undefined : lines[inheritLine].match(/=\s*["']([A-Za-z]+)["']/)?.[1]?.toLowerCase();

  const edits: Array<{ start: number; remove: number; insert: string[] }> = [];
  let includeVars: string[];
  if (widenedFrom) {
    // An earlier launch already widened this copy; its list holds what the user's policy passed.
    includeVars = mergeUniqueStrings(existingVars, normalizedRequired);
  } else if (inherit === "core" || inherit === "none") {
    const passed = [...(inherit === "core" ? CODEX_CORE_ENV_VARS : []), ...readShellEnvironmentSetKeys(lines)];
    const kept =
      existingVars.length === 0
        ? passed
        : passed.filter((name) => existingVars.some((pattern) => matchesEnvPattern(name, pattern)));
    includeVars = mergeUniqueStrings(Array.from(new Set(kept)).sort(), normalizedRequired);
    // Codex's default excludes drop names with KEY, SECRET or TOKEN before `set`
    // and `include_only` apply. Of the listed names only Takode's own token
    // matches, so turning them off lets just that through.
    edits.push({
      start: inheritLine,
      remove: 1,
      insert: [
        `# Takode: inherit was "${inherit}"; commands get only the variables in include_only.`,
        'inherit = "all"',
        ...(ignoreDefaultExcludesLine === -1 ? ["ignore_default_excludes = true"] : []),
      ],
    });
    if (ignoreDefaultExcludesLine !== -1) {
      edits.push({ start: ignoreDefaultExcludesLine, remove: 1, insert: ["ignore_default_excludes = true"] });
    }
  } else {
    includeVars = mergeUniqueStrings(existingVars, normalizedAll);
  }
  const replacement = renderIncludeOnlyArray(includeVars);
  edits.push(
    includeStart === -1
      ? { start: sectionStart + 1, remove: 0, insert: replacement }
      : { start: includeStart, remove: includeEnd - includeStart + 1, insert: replacement },
  );

  // Apply from the bottom up so earlier line numbers stay valid.
  const out = [...lines];
  edits.sort((a, b) => b.start - a.start || b.remove - a.remove);
  for (const edit of edits) out.splice(edit.start, edit.remove, ...edit.insert);
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

function findSectionStart(lines: string[], header: string): number {
  return lines.findIndex((line) => line.trim().toLowerCase() === header.toLowerCase());
}

function findSectionEnd(lines: string[], sectionStart: number): number {
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) return i;
  }
  return lines.length;
}

/** Names the policy's `set` table adds, from `[shell_environment_policy.set]` or an inline `set = { ... }`. */
function readShellEnvironmentSetKeys(lines: string[]): string[] {
  const keys: string[] = [];
  const keyPattern = /["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*=/g;
  const setStart = findSectionStart(lines, SHELL_ENV_POLICY_SET_HEADER);
  if (setStart !== -1) {
    for (const line of lines.slice(setStart + 1, findSectionEnd(lines, setStart))) {
      const key = line.match(/^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*=/)?.[1];
      if (key) keys.push(key);
    }
  }
  const sectionStart = findSectionStart(lines, SHELL_ENV_POLICY_HEADER);
  for (const line of lines.slice(sectionStart + 1, findSectionEnd(lines, sectionStart))) {
    const inline = line.match(/^\s*set\s*=\s*\{(.*)\}/)?.[1];
    if (inline) for (const match of inline.matchAll(keyPattern)) keys.push(match[1]);
  }
  return keys;
}

/** Codex's `include_only` patterns: case-insensitive globs with `*` and `?`. */
function matchesEnvPattern(name: string, pattern: string): boolean {
  const source = pattern
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char)))
    .join("");
  return new RegExp(`^${source}$`, "i").test(name);
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
