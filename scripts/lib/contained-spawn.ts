/**
 * Pure builders for the tp-request CONTAINED session (activation precondition 0).
 *
 * These live in their own module (not tripline-api-server.ts) because that file
 * boots an HTTP server on import — so this security-critical string construction
 * would be untestable there. Here it has zero side effects and is unit-tested
 * behaviourally (tests/unit/tp-request-containment.test.ts).
 *
 * See scripts/tp-request-contained/README.md for the two-layer containment design.
 */

/** The separate unix user the contained session runs as (layer A). */
export const TP_AGENT_USER = 'tp-agent';

/** 單輪 `claude -p` 的 tool-call 輪數上限；耗盡時 claude 以 exit 1 結束（實測），worker 視為失敗並收屍。 */
export const PRINT_MAX_TURNS = 150;

/** Minimal, secret-free PATH for the scrubbed (`env -i`) contained claude process. */
export const CONTAINED_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** POSIX shell single-quote escape for values injected into an inline shell command.
 *  Security-sensitive (shell injection) — ONE definition so the token, the trip id,
 *  and every path escape the same way and can't drift apart. */
export function shSingleQuote(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/**
 * Build the inline shell command for a contained `claude -p "<skill>"` run (headless print
 * mode; the process exits when the skill is done). v2.30.7 abandoned `-p` for cold-boot
 * reliability, then the interactive REPL left finished sessions idle so a request arriving
 * on the same trip afterwards was never picked up; 2026-10-27 live probe on CLI 2.1.311 under
 * tp-agent + `env -i` + dontAsk: 22/22 runs exit 0 in ~6s, skill + MCP load fine → `-p` is the
 * only contained path again.
 *
 * Security invariants (unit-tested):
 *   - runs as tp-agent via `sudo -n -u tp-agent` (layer A: FS isolation)
 *   - `env -i` scrubs the environment (no inherited CLIENT_SECRET / refresh token)
 *   - `--permission-mode dontAsk` + `--settings` + `--strict-mcp-config` = layer B lockdown
 *   - NO `--dangerously-skip-permissions` / bypassPermissions
 *   - `--max-turns` caps one run's tool-call budget (an injected message can't loop billed calls)
 *   - neither the restrict API token NOR CLAUDE_CODE_OAUTH_TOKEN is on the command line:
 *     the API token lives in the 0600 mcp-config file; the OAuth subscription token
 *     (from `claude setup-token`) is read from a 0600 file into the env by an sh wrapper
 *     (`$(cat "$1")`) — so neither ever lands in `ps` / any log.
 */
export function buildContainedShellCommand(o: {
  claudeBin: string;
  sessionDir: string;
  settingsPath: string;
  mcpConfigPath: string;
  tokenFilePath: string;
  /** `claude -p` 要跑的 skill 指令（呼叫端已過白名單；這裡仍會 single-quote）。 */
  skillCommand: string;
}): string {
  const q = shSingleQuote;
  const env = [
    `PATH='${CONTAINED_PATH}'`,
    `HOME='/Users/${TP_AGENT_USER}'`,
    `TMPDIR='${q(`${o.sessionDir}/tmp`)}'`,
    `CLAUDE_CONFIG_DIR='${q(`${o.sessionDir}/config`)}'`,
    `LANG='en_US.UTF-8'`,
  ].join(' ');
  // sh wrapper (runs as tp-agent):
  //   1. `cd` into the session dir FIRST — that dir is the workspace claude trusts.
  //      The api-server user can't chdir into it (tp-agent-0700), so we cd inside the
  //      wrapper where we already are tp-agent. `|| exit 97` fails CLOSED (claude never runs un-cwd'd in
  //      the repo, which would trigger a workspace-trust dialog on the repo's allow list).
  //   2. read the OAuth token out of a 0600 file into CLAUDE_CODE_OAUTH_TOKEN.
  //   3. exec `claude -p <skill>`. Positional args ($1..$6) keep every value —
  //      incl. the token FILE path — off claude's own argv (no `ps` leak).
  const inner =
    'cd "$1" || exit 97; CLAUDE_CODE_OAUTH_TOKEN=$(cat "$2") exec "$3" -p "$6" ' +
    `--max-turns ${PRINT_MAX_TURNS} --permission-mode dontAsk --settings "$4" --mcp-config "$5" --strict-mcp-config`;
  return (
    `sudo -n -u ${TP_AGENT_USER} env -i ${env} /bin/sh -c '${inner}' tp-contained ` +
    `'${q(o.sessionDir)}' '${q(o.tokenFilePath)}' '${q(o.claudeBin)}' ` +
    `'${q(o.settingsPath)}' '${q(o.mcpConfigPath)}' '${q(o.skillCommand)}'`
  );
}

/**
 * MCP-config JSON for the contained session. The restrict token + trip go in the
 * server's `env` block because Claude Code stdio MCP servers do NOT inherit the
 * parent (claude) environment — they must be passed explicitly here.
 */
export function buildMcpConfig(o: {
  nodeBin: string;
  mcpServerPath: string;
  token: string;
  restrictTrip: string;
}): string {
  return JSON.stringify({
    mcpServers: {
      tripline: {
        type: 'stdio',
        command: o.nodeBin,
        args: [o.mcpServerPath],
        env: { TRIPLINE_API_TOKEN: o.token, TRIPLINE_RESTRICT_TRIP: o.restrictTrip },
      },
    },
  });
}
