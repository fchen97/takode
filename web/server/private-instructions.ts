import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_PRIVATE_DOCS_DIR = join(homedir(), ".companion", "private-docs");
const DEFAULT_CONFIG_FILENAME = "default-instructions.json";
const FALLBACK_DEFAULT_DOCS = ["default-agent-guidance.md"];
const DEFAULT_MAX_BYTES = 32 * 1024;
const HARD_MAX_BYTES = 128 * 1024;

interface PrivateInstructionDoc {
  label: string;
  content: string;
}

interface PrivateInstructionConfig {
  enabled?: boolean;
  include?: unknown;
  maxBytes?: unknown;
}

export interface LoadPrivateDefaultInstructionsOptions {
  privateDocsDir?: string;
  configPath?: string;
  maxBytes?: number;
}

export function getDefaultPrivateDocsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TAKODE_PRIVATE_DOCS_DIR?.trim() || DEFAULT_PRIVATE_DOCS_DIR;
}

export async function loadPrivateDefaultInstructions(
  options: LoadPrivateDefaultInstructionsOptions = {},
): Promise<string | undefined> {
  const privateDocsDir = resolve(options.privateDocsDir ?? getDefaultPrivateDocsDir());
  const configPath = resolveConfigPath(privateDocsDir, options.configPath);
  const config = await readPrivateInstructionConfig(configPath);
  if (config?.enabled === false) return undefined;

  const includeEntries = getIncludeEntries(config);
  const maxBytes = normalizeMaxBytes(options.maxBytes ?? normalizeConfigMaxBytes(config?.maxBytes));
  const docs = await readIncludedDocs(privateDocsDir, includeEntries, maxBytes);
  if (docs.length === 0) return undefined;

  return formatPrivateDefaultInstructions(docs);
}

function resolveConfigPath(privateDocsDir: string, configPath?: string): string {
  if (!configPath) return join(privateDocsDir, DEFAULT_CONFIG_FILENAME);
  return isAbsolute(configPath) ? configPath : resolve(privateDocsDir, configPath);
}

async function readPrivateInstructionConfig(configPath: string): Promise<PrivateInstructionConfig | undefined> {
  if (!(await fileExists(configPath))) return undefined;
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as PrivateInstructionConfig;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[private-instructions] Ignoring unreadable private instruction config at ${configPath}: ${message}`);
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getIncludeEntries(config: PrivateInstructionConfig | undefined): string[] {
  if (!config || config.include === undefined) return FALLBACK_DEFAULT_DOCS;
  if (!Array.isArray(config.include)) return [];
  return config.include.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeConfigMaxBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(value), HARD_MAX_BYTES);
}

async function readIncludedDocs(
  privateDocsDir: string,
  includeEntries: string[],
  maxBytes: number,
): Promise<PrivateInstructionDoc[]> {
  const docs: PrivateInstructionDoc[] = [];
  let remainingBytes = maxBytes;

  for (const includeEntry of includeEntries) {
    if (remainingBytes <= 0) break;

    const resolvedPath = resolvePrivateDocPath(privateDocsDir, includeEntry);
    if (!resolvedPath) {
      console.warn(`[private-instructions] Skipping private instruction outside private docs dir: ${includeEntry}`);
      continue;
    }
    if (!(await fileExists(resolvedPath))) continue;

    try {
      const raw = (await readFile(resolvedPath, "utf-8")).trim();
      if (!raw) continue;
      const truncated = truncateUtf8(raw, remainingBytes);
      if (!truncated.text) break;
      remainingBytes -= Buffer.byteLength(truncated.text, "utf-8");
      docs.push({ label: includeEntry, content: appendTruncationNote(truncated.text, truncated.truncated) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[private-instructions] Skipping unreadable private instruction doc ${includeEntry}: ${message}`);
    }
  }

  return docs;
}

function resolvePrivateDocPath(privateDocsDir: string, includeEntry: string): string | undefined {
  const resolved = isAbsolute(includeEntry) ? resolve(includeEntry) : resolve(privateDocsDir, includeEntry);
  const rel = relative(privateDocsDir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return resolved;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return { text: value, truncated: false };

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf-8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return { text: value.slice(0, low).trimEnd(), truncated: true };
}

function appendTruncationNote(content: string, truncated: boolean): string {
  if (!truncated) return content;
  return `${content}\n\n[Truncated by Takode private-instruction loader to stay within prompt budget.]`;
}

function formatPrivateDefaultInstructions(docs: PrivateInstructionDoc[]): string {
  const body = docs.map((doc) => `### ${doc.label}\n\n${doc.content}`).join("\n\n");
  return `## Private Default Instructions

These local-only instructions were loaded from Takode private docs. Follow them as defaults for this environment unless current user or project instructions explicitly override them. Do not assume other private docs are in scope unless they are included here.

${body}`;
}
