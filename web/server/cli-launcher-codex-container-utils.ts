import { dirname } from "node:path";

export function renderContainerCodexFileWrite(path: string, contents: string, heredocMarker: string): string {
  const normalizedContents = contents.replace(/\r\n/g, "\n");
  const fileBody = normalizedContents.endsWith("\n") ? normalizedContents.slice(0, -1) : normalizedContents;
  const contentLines = new Set(normalizedContents.split("\n"));
  let resolvedMarker = heredocMarker;
  for (let suffix = 1; contentLines.has(resolvedMarker); suffix += 1) {
    resolvedMarker = `${heredocMarker}_${suffix}`;
  }
  return [
    `mkdir -p ${JSON.stringify(dirname(path))}`,
    `cat > ${JSON.stringify(path)} <<'${resolvedMarker}'`,
    fileBody,
    resolvedMarker,
  ].join("\n");
}

export function renderContainerCodexConfigWrite(configToml: string): string {
  return renderContainerCodexFileWrite("/root/.codex/config.toml", configToml, "__COMPANION_CODEX_CONFIG__");
}

export function renderContainerCodexAuthRefresh(): string {
  return [
    "if [ -f /companion-host-codex/auth.json ]; then",
    "mkdir -p /root/.codex",
    "rm -f /root/.codex/auth.json",
    "cp /companion-host-codex/auth.json /root/.codex/auth.json 2>/dev/null || true",
    "fi",
  ].join("\n");
}
