import { describe, expect, it } from "vitest";
import { upsertShellEnvironmentPolicy } from "./cli-launcher-codex-config-utils.js";

/** Codex's `inherit = "core"` variables on Unix (current Codex). */
const CODEX_CORE = ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"];

function globMatches(name: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i").test(name);
}

/**
 * The environment Codex gives a command under `configToml`, following Codex's
 * order: inherit, default excludes, excludes, `set`, then `include_only`.
 */
function codexCommandEnv(configToml: string, env: Record<string, string>): Record<string, string> {
  const policy = ((Bun.TOML.parse(configToml) as Record<string, unknown>).shell_environment_policy ?? {}) as {
    inherit?: string;
    ignore_default_excludes?: boolean;
    exclude?: string[];
    set?: Record<string, string>;
    include_only?: string[];
  };
  const inherit = policy.inherit ?? "all";
  let vars: Record<string, string> =
    inherit === "all"
      ? { ...env }
      : inherit === "none"
        ? {}
        : Object.fromEntries(Object.entries(env).filter(([name]) => CODEX_CORE.includes(name)));
  const drop = (patterns: string[]) => {
    vars = Object.fromEntries(Object.entries(vars).filter(([name]) => !patterns.some((p) => globMatches(name, p))));
  };
  if (policy.ignore_default_excludes === false) drop(["*KEY*", "*SECRET*", "*TOKEN*"]);
  drop(policy.exclude ?? []);
  vars = { ...vars, ...(policy.set ?? {}) };
  const includeOnly = policy.include_only ?? [];
  if (includeOnly.length > 0) {
    vars = Object.fromEntries(Object.entries(vars).filter(([name]) => includeOnly.some((p) => globMatches(name, p))));
  }
  return vars;
}

// What a Takode-launched Codex process sees on a host: core variables, Takode's
// own variables, the provider's key, and an unrelated secret from the machine.
const PROCESS_ENV = {
  HOME: "/home/coder",
  PATH: "/usr/bin",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  USER: "coder",
  GIT_EDITOR: "true",
  COMPANION_PORT: "13456",
  COMPANION_AUTH_TOKEN: "session-token",
  TAKODE_REMOTE_HOST: "1",
  LITELLM_API_KEY: "provider-key",
  CODER_AGENT_TOKEN: "unrelated-secret",
};
const TAKODE_VARS = ["COMPANION_PORT", "COMPANION_AUTH_TOKEN", "TAKODE_REMOTE_HOST"];
const REQUIRED = ["HOME", "PATH", "GIT_EDITOR", ...TAKODE_VARS];
const INHERITED = ["LITELLM_API_KEY"];

function pick(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, PROCESS_ENV[name as keyof typeof PROCESS_ENV]]));
}

describe("upsertShellEnvironmentPolicy", () => {
  // The failure seen on a Linux host: with inherit = "core", include_only cannot
  // bring back Takode's variables, so quest/memory/takode had no server to ask.
  it("passes Takode's variables under inherit = core while keeping other variables out", () => {
    const user = ["[shell_environment_policy]", 'inherit = "core"', ""].join("\n");
    const before = codexCommandEnv(user, PROCESS_ENV);
    expect(before.COMPANION_PORT).toBeUndefined();

    const session = upsertShellEnvironmentPolicy(user, REQUIRED, INHERITED);
    const after = codexCommandEnv(session, PROCESS_ENV);
    // Everything the user's policy passed, plus Takode's variables and nothing else:
    // neither the provider's key nor the unrelated secret.
    expect(after).toEqual({ ...before, ...pick(REQUIRED) });
    expect(after.CODER_AGENT_TOKEN).toBeUndefined();
    expect(after.LITELLM_API_KEY).toBeUndefined();
  });

  // The session copy keeps the widened policy, and the next launch runs this
  // again on it: the result must not change or start passing the provider key.
  it("is stable across launches of the same session copy", () => {
    const user = ["[shell_environment_policy]", 'inherit = "core"', ""].join("\n");
    const once = upsertShellEnvironmentPolicy(user, REQUIRED, INHERITED);
    expect(once).toContain('# Takode: inherit was "core"');
    expect(upsertShellEnvironmentPolicy(once, REQUIRED, INHERITED)).toBe(once);

    // A later launch with another Takode variable adds just that one.
    const later = upsertShellEnvironmentPolicy(once, [...REQUIRED, "TAKODE_ROLE"], INHERITED);
    const env = codexCommandEnv(later, { ...PROCESS_ENV, TAKODE_ROLE: "worker" });
    expect(env.TAKODE_ROLE).toBe("worker");
    expect(env.LITELLM_API_KEY).toBeUndefined();
  });

  // Under inherit = "none" commands got only `set`; afterwards they get that plus
  // Takode's variables, and `set` values still win over the environment.
  it("keeps set values and passes Takode's variables under inherit = none", () => {
    const user = [
      "[shell_environment_policy]",
      'inherit = "none"',
      "",
      "[shell_environment_policy.set]",
      'PAGER = "cat"',
      'PATH = "/opt/tools"',
      "",
    ].join("\n");
    const after = codexCommandEnv(upsertShellEnvironmentPolicy(user, REQUIRED, INHERITED), PROCESS_ENV);
    expect(after).toEqual({ ...pick(REQUIRED), PAGER: "cat", PATH: "/opt/tools" });
  });

  // A user's include_only narrowed what core passed; that narrowing stays, and an
  // inline `set` table is honoured as well.
  it("keeps the user's include_only narrowing of the core variables", () => {
    const user = [
      "[shell_environment_policy]",
      'inherit = "core"',
      'include_only = ["PATH", "HOME", "LA*", "EDITOR"]',
      'set = { EDITOR = "vi" }',
      "",
    ].join("\n");
    const before = codexCommandEnv(user, PROCESS_ENV);
    expect(before).toEqual({ PATH: "/usr/bin", HOME: "/home/coder", LANG: "C.UTF-8", EDITOR: "vi" });
    const after = codexCommandEnv(upsertShellEnvironmentPolicy(user, REQUIRED, INHERITED), PROCESS_ENV);
    expect(after).toEqual({ ...before, ...pick(REQUIRED) });
    expect(after.SHELL).toBeUndefined();
  });

  // Codex's default excludes (KEY/SECRET/TOKEN) would drop Takode's session token.
  it("lets Takode's token through when the user turned the default excludes on", () => {
    const user = ["[shell_environment_policy]", 'inherit = "core"', "ignore_default_excludes = false", ""].join("\n");
    const session = upsertShellEnvironmentPolicy(user, REQUIRED, INHERITED);
    expect(Bun.TOML.parse(session)).toMatchObject({ shell_environment_policy: { ignore_default_excludes: true } });
    const after = codexCommandEnv(session, PROCESS_ENV);
    expect(after.COMPANION_AUTH_TOKEN).toBe("session-token");
    expect(after.CODER_AGENT_TOKEN).toBeUndefined();
  });

  // With the environment inherited (the default), Takode only lists its
  // variables and the provider's key, as before.
  it("lists required and inherited variables when the user's policy inherits everything", () => {
    for (const user of ["", ["[shell_environment_policy]", 'include_only = ["SHELL"]', ""].join("\n")]) {
      const session = upsertShellEnvironmentPolicy(user, REQUIRED, INHERITED);
      expect(session).not.toContain("Takode: inherit was");
      const after = codexCommandEnv(session, PROCESS_ENV);
      expect(after).toEqual({
        ...pick([...REQUIRED, ...INHERITED]),
        ...(user ? { SHELL: "/bin/bash" } : {}),
      });
    }
  });
});
