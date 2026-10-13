// Keeps a long-running shipcue command up as a service: a macOS launchd agent or a Linux systemd
// --user unit, restarted when it stops, with its token in the unit (kept at mode 600). The same
// shape as shipcue Cloud's "Run a listener" setup (website/_src/listener.mjs there), for any command.

export interface ServiceSpec {
  /** A file-name-safe name, e.g. "runner-habitect". */
  name: string;
  description: string;
  /** The command, run through a login shell so npx, claude and codex are on PATH. */
  command: string;
  env: Record<string, string>;
  /** Absolute, or starting with ~/ for home. */
  workingDirectory: string;
}

/** A file-name-safe name: "Habitect (web)" → "habitect-web". */
export function slug(name: string): string {
  const s = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'project';
}

/** One shell word: left bare when safe, else single-quoted. */
export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

const xml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export const launchdLabel = (name: string) => `com.shipcue.${slug(name)}`;
export const systemdName = (name: string) => `shipcue-${slug(name)}`;

/** The launchd agent; `home` is the absolute home folder (launchd does not expand ~). */
export function launchdPlist(s: ServiceSpec, home: string): string {
  const dir = s.workingDirectory.startsWith('~/') ? `${home}/${s.workingDirectory.slice(2)}` : s.workingDirectory === '~' ? home : s.workingDirectory;
  const log = `${home}/Library/Logs/shipcue-${slug(s.name)}.log`;
  const env = Object.entries(s.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(launchdLabel(s.name))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(s.command)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
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

/** systemd treats % and $ in unit files as its own; double them to keep them literal. */
const unitText = (t: string) => t.replace(/%/g, '%%').replace(/\$/g, '$$$$');
const unitArg = (t: string) => `"${unitText(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function systemdUnit(s: ServiceSpec): string {
  const dir = s.workingDirectory === '~' ? '%h' : s.workingDirectory.startsWith('~/') ? `%h/${unitText(s.workingDirectory.slice(2))}` : unitText(s.workingDirectory);
  return `[Unit]
Description=${unitText(s.description)}
After=network-online.target
Wants=network-online.target

[Service]
${Object.entries(s.env)
  .map(([k, v]) => `Environment=${unitArg(`${k}=${v}`)}`)
  .join('\n')}
WorkingDirectory=${dir}
ExecStart=/bin/bash -lc ${unitArg(s.command)}
Restart=always
RestartSec=30
# SIGTERM first, so the runner hands its jobs back before it stops.
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=default.target
`;
}

/** Where the service file goes, and the commands that (re)start it and show its log. */
export function serviceFiles(s: ServiceSpec, platform: NodeJS.Platform, home: string) {
  if (platform === 'darwin') {
    const label = launchdLabel(s.name);
    return {
      path: `${home}/Library/LaunchAgents/${label}.plist`,
      text: launchdPlist(s, home),
      start: [
        ['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/${label}`],
        ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, `${home}/Library/LaunchAgents/${label}.plist`],
      ],
      logs: `tail -f ~/Library/Logs/shipcue-${slug(s.name)}.log`,
      stop: `launchctl bootout gui/$(id -u)/${label}`,
    };
  }
  const name = systemdName(s.name);
  return {
    path: `${home}/.config/systemd/user/${name}.service`,
    text: systemdUnit(s),
    start: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', name],
      ['systemctl', '--user', 'restart', name],
    ],
    logs: `journalctl --user -u ${name} -f`,
    stop: `systemctl --user disable --now ${name}`,
  };
}
