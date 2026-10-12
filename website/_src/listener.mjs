// "Run a listener" in Cloud's Setup tab (shipcue report 3d2dded6): the text people copy to keep
// shipcue-listen running as a daemon, as one command, a macOS launchd agent or a Linux systemd
// --user unit. Pure functions, so the generated text is unit-tested (tests/listener.test.ts).

export const DEFAULT_LISTEN_COMMAND =
  'claude -p "Use the shipcue MCP tools to claim the report in $SHIPCUE_REPORT_ID, fix it, open a PR and submit it for review"';

/** The prebuilt release (shipcue is not on npm yet). */
export const releaseTarball = (version) => `https://github.com/cyu60/shipcue/releases/download/v${version}/shipcue-${version}.tgz`;

/** A file-name-safe name for the project: "Habitect (web)" → "habitect-web". */
export function slug(name) {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'project';
}

/** One shell word: left bare when safe, else single-quoted. */
export function shq(s) {
  const t = String(s);
  return /^[\w@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`;
}

/** A folder for the shell, keeping a leading ~/ so it still means home. */
const shDir = (dir) => (dir.startsWith('~/') ? `~/${shq(dir.slice(2))}` : shq(dir));

const xml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function normalise(o) {
  const events = o.events?.length ? o.events : ['filed'];
  return {
    ...o,
    events,
    command: (o.command ?? '').trim() || DEFAULT_LISTEN_COMMAND,
    folder: (o.folder ?? '').trim() || '~',
    name: slug(o.project),
  };
}

/**
 * shipcue-listen and the command it runs per event. The command goes through sh -c in single
 * quotes, so $SHIPCUE_REPORT_ID is filled in for each event, not when the listener starts.
 */
export function listenArgs(o) {
  const n = normalise(o);
  return `npx -y -p ${releaseTarball(n.version)} shipcue-listen --on ${n.events.join(',')} -- sh -c ${shq(n.command)}`;
}

/** The one-line command, run from the folder the agent works in. */
export function listenCommand(o) {
  const n = normalise(o);
  const env = `SHIPCUE_URL=${shq(n.url)} SHIPCUE_TOKEN=${shq(n.token)} SHIPCUE_AGENT=${shq(n.agent)}`;
  return `${n.folder === '~' ? '' : `cd ${shDir(n.folder)} && `}${env} ${listenArgs(n)}`;
}

export const launchdLabel = (project) => `com.shipcue.listen.${slug(project)}`;

/**
 * A launchd agent that keeps the listener running (KeepAlive) and logs to
 * ~/Library/Logs/shipcue-listen-<project>.log. `home` is the absolute home folder; launchd does not
 * expand ~. It runs through a login shell so npx and claude are on PATH.
 */
export function launchdPlist(o) {
  const n = normalise(o);
  const home = o.home ?? '/Users/you';
  const dir = n.folder === '~' ? home : n.folder.startsWith('~/') ? `${home}/${n.folder.slice(2)}` : n.folder;
  const log = `${home}/Library/Logs/shipcue-listen-${n.name}.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(launchdLabel(o.project))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(listenArgs(n))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SHIPCUE_URL</key>
    <string>${xml(n.url)}</string>
    <key>SHIPCUE_TOKEN</key>
    <string>${xml(n.token)}</string>
    <key>SHIPCUE_AGENT</key>
    <string>${xml(n.agent)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(dir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Writes the plist (with this Mac's $HOME), keeps it private (it holds the token) and starts it. */
export function launchdInstall(o) {
  const label = launchdLabel(o.project);
  const file = `~/Library/LaunchAgents/${label}.plist`;
  // Unquoted heredoc so $HOME is filled in; everything else is escaped to stay as written.
  const HOME = '__SHIPCUE_HOME__';
  const body = launchdPlist({ ...o, home: HOME }).replace(/[\\$`]/g, (c) => `\\${c}`).split(HOME).join('$HOME');
  return `mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cat > ${file} <<EOF
${body}EOF
chmod 600 ${file}
launchctl bootout gui/$(id -u)/${label} 2>/dev/null
launchctl bootstrap gui/$(id -u) ${file}
# Logs: tail -f ~/Library/Logs/shipcue-listen-${slug(o.project)}.log   Stop: launchctl bootout gui/$(id -u)/${label}
`;
}

export const systemdName = (project) => `shipcue-listen-${slug(project)}`;

/** systemd treats % and $ in unit files as its own; double them to keep them literal. */
const unitText = (t) => String(t).replace(/%/g, '%%').replace(/\$/g, '$$$$');
/** A double-quoted systemd argument. */
const unitArg = (t) => `"${unitText(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The same listener as a systemd --user service, restarted whenever it stops. */
export function systemdUnit(o) {
  const n = normalise(o);
  const dir = n.folder === '~' ? '%h' : n.folder.startsWith('~/') ? `%h/${unitText(n.folder.slice(2))}` : unitText(n.folder);
  return `[Unit]
Description=shipcue listener for ${unitText(o.project ?? n.name)}
After=network-online.target
Wants=network-online.target

[Service]
Environment=${unitArg(`SHIPCUE_URL=${n.url}`)}
Environment=${unitArg(`SHIPCUE_TOKEN=${n.token}`)}
Environment=${unitArg(`SHIPCUE_AGENT=${n.agent}`)}
WorkingDirectory=${dir}
ExecStart=/bin/bash -lc ${unitArg(listenArgs(n))}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}

/** Writes the unit, keeps it private, starts it now and at boot (linger: even when logged out). */
export function systemdInstall(o) {
  const name = systemdName(o.project);
  const file = `~/.config/systemd/user/${name}.service`;
  return `mkdir -p ~/.config/systemd/user
cat > ${file} <<'EOF'
${systemdUnit(o)}EOF
chmod 600 ${file}
systemctl --user daemon-reload
systemctl --user enable --now ${name}
loginctl enable-linger "$USER"
# Logs: journalctl --user -u ${name} -f   Stop: systemctl --user disable --now ${name}
`;
}

const fence = (body) => `\`\`\`sh\n${body.trimEnd()}\n\`\`\``;

/**
 * One prompt to paste into Claude Code (or Codex) on the machine that should work the queue: it checks
 * the tools and the folder, gives Claude the shipcue MCP tools, checks the token, installs the listener
 * as a service (launchd on macOS, systemd on Linux) and checks it is running. Everything it runs is
 * the same text the Command / launchd / systemd tabs show, so the prompt never drifts from them.
 */
export function setupPrompt(o) {
  const n = normalise(o);
  const mcp = `claude mcp add shipcue -e SHIPCUE_URL=${shq(n.url)} -e SHIPCUE_TOKEN=${shq(n.token)} -- npx -y -p ${releaseTarball(n.version)} shipcue-mcp`;
  const label = launchdLabel(o.project);
  const unit = systemdName(o.project);
  return `Set up this machine to work my shipcue Cloud project "${o.project ?? n.name}" as the agent "${n.agent}", and keep it running after this chat ends. Do every step yourself; stop and ask me only for what only I can do (a password, a login, which repo).

- Project endpoint: ${n.url}
- Agent token: ${n.token}
  It is a secret: never print it back, never commit it, and only put it where the commands below put it (files kept at mode 600). If it is still a <placeholder>, ask me for the token first.
- Folder the agent works in: ${n.folder}
- What runs for each report: ${n.command}

1. Tools. Check node 20+ (with npx), git, gh (signed in: \`gh auth status\`) and claude (Claude Code, signed in). Install what is missing (Homebrew on macOS, the package manager on Linux), or tell me exactly what to run.
2. Folder. Make sure ${n.folder} exists and is a git checkout of the app this project's reports are about, with a remote the agent can push branches to. If it is not, ask me for the repo URL and clone it there.
3. shipcue tools for Claude. In that folder (run \`claude mcp remove shipcue\` first if one is already there):
${fence(`cd ${n.folder === '~' ? '~' : shDir(n.folder)}\n${mcp}`)}
4. Token. This must print "token ok"; a 401 means the token is wrong or was revoked, so stop and tell me:
${fence(`curl -fsS -H ${shq(`Authorization: Bearer ${n.token}`)} ${shq(`${n.url}/reports?status=open`)} >/dev/null && echo token ok`)}
5. Listener service. On macOS run this as is:
${fence(launchdInstall(o))}
   Then ask me to run \`sudo pmset -a sleep 0 disablesleep 1\` so the Mac stays awake, and to turn on automatic login, so it comes back after a restart.
   On Linux run this as is instead:
${fence(systemdInstall(o))}
6. Check it. macOS: \`launchctl print gui/$(id -u)/${label} | grep -m1 state\` says running, and \`tail ~/Library/Logs/shipcue-listen-${n.name}.log\` shows no errors after 30 seconds. Linux: \`systemctl --user status ${unit}\`. If the log says npx or claude is not found, the service's login shell does not see them (nvm and similar set PATH only in interactive shells): put their folder on PATH in ~/.zprofile (macOS) or ~/.profile (Linux) and restart the service.
7. Unattended runs. The command above runs once per event with nobody watching, so it must not stop on a permission prompt: make sure Claude Code is allowed to edit files and run git, gh and the app's tests in ${n.folder} (its .claude/settings.local.json), or tell me which permission mode you suggest.
8. Tell me in a few lines: what you installed, where the log is, how to stop it (\`launchctl bootout gui/$(id -u)/${label}\` or \`systemctl --user disable --now ${unit}\`), and anything still waiting on me.`;
}
