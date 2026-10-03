// "Run a listener" text (shipcue report 3d2dded6): the command, the launchd agent and the systemd unit.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain JS module for the site
import * as L from '../website/_src/listener.mjs';

const opts = {
  url: 'https://shipcue.example.com/api/cloud/p/pk_0123456789abcdef01234567',
  token: 'sca_abc123',
  agent: 'mac-mini',
  events: ['filed', 'assigned'],
  command: L.DEFAULT_LISTEN_COMMAND,
  folder: "~/code/my app's",
  project: 'Habitect (web)',
  version: '0.19.0',
};
const TGZ = 'https://github.com/cyu60/shipcue/releases/download/v0.19.0/shipcue-0.19.0.tgz';
/** How bash splits a line into words, without running it. */
const words = (line: string) => execFileSync('bash', ['-c', `set -- ${line}; printf '%s\\0' "$@"`], { encoding: 'utf8', env: { HOME: '/home/t', PATH: process.env.PATH } }).split('\0').slice(0, -1);

describe('listener: the one-line command', () => {
  it('sets the env, runs the release through npx, and keeps $SHIPCUE_REPORT_ID for each event', () => {
    const line = L.listenCommand(opts);
    expect(line.startsWith("cd ~/'code/my app'\\''s' && SHIPCUE_URL=")).toBe(true);
    const run = line.slice(line.indexOf('&& ') + 3);
    expect(words(run)).toEqual([
      `SHIPCUE_URL=${opts.url}`,
      'SHIPCUE_TOKEN=sca_abc123',
      'SHIPCUE_AGENT=mac-mini',
      'npx', '-y', '-p', TGZ, 'shipcue-listen', '--on', 'filed,assigned', '--', 'sh', '-c',
      L.DEFAULT_LISTEN_COMMAND,
    ]);
  });

  it('defaults to filed and the claude command, and quotes anything odd', () => {
    const line = L.listenCommand({ ...opts, events: [], command: '  ', folder: '' });
    expect(line).toContain('--on filed --');
    expect(line).not.toContain('cd ');
    expect(words(line).at(-1)).toBe(L.DEFAULT_LISTEN_COMMAND);
    expect(words(L.listenCommand({ ...opts, folder: '', token: "a'b $(rm -rf /)" }))[1]).toBe("SHIPCUE_TOKEN=a'b $(rm -rf /)");
  });

  it('names files after the project', () => {
    expect(L.slug('Habitect (web)')).toBe('habitect-web');
    expect(L.slug('!!!')).toBe('project');
    expect(L.launchdLabel('Habitect (web)')).toBe('com.shipcue.listen.habitect-web');
    expect(L.systemdName('Habitect (web)')).toBe('shipcue-listen-habitect-web');
  });
});

describe('listener: macOS launchd', () => {
  it('keeps it alive, logs to ~/Library/Logs/shipcue-listen-<project>.log and runs in the folder', () => {
    const plist = L.launchdPlist({ ...opts, home: '/Users/ada' });
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<string>/Users/ada/Library/Logs/shipcue-listen-habitect-web.log</string>');
    expect(plist).toContain('<string>/Users/ada/code/my app&apos;s</string>');
    expect(plist).toContain('<string>/bin/zsh</string>\n    <string>-lc</string>');
    expect(plist).toContain('<key>SHIPCUE_TOKEN</key>\n    <string>sca_abc123</string>');
    expect(plist).toContain('$SHIPCUE_REPORT_ID');
    if (existsSync('/usr/bin/plutil')) {
      const f = join(mkdtempSync(join(tmpdir(), 'sc-')), 'x.plist');
      writeFileSync(f, plist);
      expect(execFileSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' })).toContain('OK');
    }
  });

  it('the install script writes exactly that plist with this Mac\'s $HOME, then bootstraps it', () => {
    const script = L.launchdInstall(opts);
    expect(script).toContain('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shipcue.listen.habitect-web.plist');
    expect(script).toContain('chmod 600 ~/Library/LaunchAgents/com.shipcue.listen.habitect-web.plist');
    // Run only the heredoc part, with a fake home, and compare.
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const write = script.split('\n').filter((l: string) => !l.startsWith('launchctl') && !l.startsWith('chmod') && !l.startsWith('#')).join('\n');
    execFileSync('bash', ['-c', write], { env: { HOME: home, PATH: process.env.PATH } });
    const written = readFileSync(join(home, 'Library/LaunchAgents/com.shipcue.listen.habitect-web.plist'), 'utf8');
    expect(written).toBe(L.launchdPlist({ ...opts, home }));
  });
});

describe('listener: Linux systemd --user', () => {
  it('restarts always, runs in %h/<folder>, and escapes $ and % for systemd', () => {
    const unit = L.systemdUnit({ ...opts, command: 'echo 100% $SHIPCUE_REPORT_ID' });
    expect(unit).toContain('Restart=always');
    expect(unit).toContain("WorkingDirectory=%h/code/my app's");
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Environment="SHIPCUE_TOKEN=sca_abc123"');
    expect(unit).toContain('echo 100%% $$SHIPCUE_REPORT_ID');
    expect(unit).toMatch(/^ExecStart=\/bin\/bash -lc "npx -y -p .* shipcue-listen --on filed,assigned -- sh -c 'echo 100%% \$\$SHIPCUE_REPORT_ID'"$/m);
  });

  it('the install script enables it now and at boot', () => {
    const script = L.systemdInstall(opts);
    expect(script).toContain("cat > ~/.config/systemd/user/shipcue-listen-habitect-web.service <<'EOF'");
    expect(script).toContain('systemctl --user enable --now shipcue-listen-habitect-web');
    expect(script).toContain('loginctl enable-linger');
    expect(script).toContain(L.systemdUnit(opts));
  });
});
