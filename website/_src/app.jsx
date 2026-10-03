// shipcue Cloud's dashboard at /app/: sign in, pick a project, and work its CueLog with the team.
// Talks to /api/cloud (cloud.mjs); the CueLog table is the package's CueLogTable on the project's team API.
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CueLogTable } from '../../src/react';
import { LISTEN_EVENTS } from '../../src/mcp/events';
import { DEFAULT_LISTEN_COMMAND, launchdInstall, listenCommand, releaseTarball, slug, systemdInstall } from './listener.mjs';

const API = '/api/cloud';
const ORIGIN = window.location.origin;
// eslint-disable-next-line no-undef
const VERSION = __SHIPCUE_VERSION__;

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'Something went wrong.'), { status: res.status });
  return data;
}

const s = {
  card: { background: 'var(--white)', border: '1px solid var(--line)', borderRadius: 12, padding: '18px 20px', display: 'grid', gap: 12 },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: { font: 'inherit', fontSize: 15, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--white)', color: 'inherit', minWidth: 0 },
  small: { fontSize: 14, color: 'var(--muted)', margin: 0 },
  error: { color: '#B91C1C', fontSize: 14, margin: 0 },
  pills: { display: 'inline-flex', gap: 3, padding: 3, border: '1px solid var(--line)', borderRadius: 999, background: 'var(--white)' },
  pill: { font: 'inherit', fontSize: 14, padding: '3px 12px', border: 0, borderRadius: 999, background: 'none', color: 'inherit', cursor: 'pointer' },
  pillOn: { background: 'var(--ink)', color: 'var(--white)' },
  btn: { font: 'inherit', fontSize: 14, padding: '5px 12px', border: '1px solid var(--line)', borderRadius: 999, background: 'var(--white)', color: 'inherit', cursor: 'pointer' },
  ink: { background: 'var(--ink)', color: 'var(--white)', borderColor: 'var(--ink)' },
  pre: { margin: 0, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 15 },
  td: { padding: '6px 4px', borderBottom: '1px solid var(--line)' },
  oauth: { display: 'block', textAlign: 'center', textDecoration: 'none', fontSize: 15, padding: '8px 12px' },
};

function Button({ ink, ...props }) {
  return <button type="button" {...props} style={{ ...s.btn, ...(ink ? s.ink : {}), ...props.style }} />;
}

function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <pre style={s.pre}>{text}</pre>
      <div>
        <Button onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true))}>{done ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}

function Auth({ onIn }) {
  const [mode, setMode] = useState('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  // Continue with Google comes back to /app/?error=... when it could not finish.
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get('error'));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('error')) return;
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url);
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'verify') {
        const r = await api('/auth/verify', { email, otp });
        if (r.needsSignIn) setMode('sign-in');
        else onIn();
      } else {
        const r = await api(`/auth/${mode}`, { email, password });
        if (r.needsVerification) setMode('verify');
        else onIn();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ ...s.card, maxWidth: 420 }}>
      <h2 style={{ margin: 0 }}>{mode === 'sign-up' ? 'Make an account' : mode === 'verify' ? 'Check your email' : 'Sign in'}</h2>
      {mode !== 'verify' && (
        <>
          <a href={`${API}/auth/oauth/google`} style={{ ...s.btn, ...s.ink, ...s.oauth }}>
            Continue with Google
          </a>
          <a href={`${API}/auth/oauth/github`} style={{ ...s.btn, ...s.oauth }}>
            Continue with GitHub
          </a>
          <p style={{ ...s.small, textAlign: 'center' }}>or with email</p>
        </>
      )}
      {mode === 'verify' ? (
        <>
          <p style={s.small}>We sent a 6-digit code to {email}.</p>
          <input style={s.input} inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={otp} onChange={(e) => setOtp(e.target.value)} required />
          <Button onClick={() => api('/auth/resend', { email }).catch(() => undefined)}>Send it again</Button>
        </>
      ) : (
        <>
          <input style={s.input} type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input
            style={s.input}
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            placeholder="Password"
            minLength={mode === 'sign-up' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </>
      )}
      {error && <p style={s.error}>{error}</p>}
      <div style={s.row}>
        <button type="submit" disabled={busy} style={{ ...s.btn, ...s.ink }}>
          {mode === 'sign-up' ? 'Sign up' : mode === 'verify' ? 'Verify' : 'Sign in'}
        </button>
        {mode !== 'verify' && (
          <Button onClick={() => setMode(mode === 'sign-up' ? 'sign-in' : 'sign-up')}>{mode === 'sign-up' ? 'I have an account' : 'Make an account'}</Button>
        )}
      </div>
      <p style={s.small}>
        {new URLSearchParams(window.location.search).get('next')
          ? 'Sign in, or make an account, to keep sending reports. You can still send them anonymously; you come straight back after.'
          : 'shipcue Cloud is invite-only for now. If a team invited you, sign up with that email and you will land in their project.'}
      </p>
    </form>
  );
}

function NewProject({ onMade }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  return (
    <form
      style={{ ...s.card, maxWidth: 420 }}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const { project } = await api('/projects', { name });
          onMade(project.id);
        } catch (err) {
          setError(err.message);
        }
      }}
    >
      <h2 style={{ margin: 0 }}>New project</h2>
      <p style={s.small}>One project per app: it gets its own queue, button key and agents.</p>
      <input style={s.input} placeholder="App name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      {error && <p style={s.error}>{error}</p>}
      <div>
        <button type="submit" style={{ ...s.btn, ...s.ink }}>
          Create
        </button>
      </div>
    </form>
  );
}

/** The MCP line for an agent's token, from the prebuilt release (shipcue is not on npm yet). */
const mcpLine = (endpoint, token) => `claude mcp add shipcue -e SHIPCUE_URL=${endpoint} -e SHIPCUE_TOKEN=${token} -- npx -y -p ${releaseTarball(VERSION)} shipcue-mcp`;

/**
 * Run a listener (shipcue report 3d2dded6): pick or create an agent, the events and the command, and copy
 * shipcue-listen as one command, a launchd agent (macOS) or a systemd --user unit (Linux).
 */
function Listener({ detail, endpoint, run }) {
  const p = detail.project;
  const [pick, setPick] = useState(detail.agents[0]?.id ?? 'new');
  const [newName, setNewName] = useState('');
  const [made, setMade] = useState(null);
  const [events, setEvents] = useState(['filed', 'assigned']);
  const [command, setCommand] = useState(DEFAULT_LISTEN_COMMAND);
  const [folder, setFolder] = useState(`~/code/${slug(p.name)}`);
  const [os, setOs] = useState('cmd');
  const agent = made && made.id === pick ? made : detail.agents.find((a) => a.id === pick);
  const opts = {
    url: endpoint,
    token: made && made.id === pick ? made.token : `<${agent?.name ?? 'agent'}'s token>`,
    agent: agent?.name ?? 'agent',
    events,
    command,
    folder,
    project: p.name,
    version: VERSION,
  };
  const create = () =>
    run(async () => {
      const r = await api(`/projects/${p.id}/agents`, { name: newName });
      setMade({ id: r.agent.id, name: r.agent.name, token: r.token });
      setPick(r.agent.id);
      setNewName('');
    });
  return (
    <section style={s.card}>
      <h3 style={{ margin: 0 }}>3. Run a listener</h3>
      <p style={s.small}>
        Keep an agent on a Mac, a VPS or any machine working the queue like a daemon: shipcue-listen checks every 15 seconds (no open port) and runs your command once per
        event, with the report's id in $SHIPCUE_REPORT_ID.
      </p>
      <div style={s.row}>
        <select style={s.input} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Agent">
          {detail.agents.map((a) => (
            <option key={a.id} value={a.id}>
              🤖 {a.name}
            </option>
          ))}
          <option value="new">New agent…</option>
        </select>
        {pick === 'new' && (
          <>
            <input style={s.input} placeholder="mac-mini" value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase())} aria-label="New agent name" />
            <Button ink onClick={create} disabled={!newName.trim()}>
              Create agent
            </Button>
          </>
        )}
      </div>
      {pick !== 'new' && (
        <>
          <div style={s.row} role="group" aria-label="Events to act on">
            {LISTEN_EVENTS.map((ev) => (
              <label key={ev} style={{ ...s.small, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
                {ev === 'assigned' ? 'assigned to it' : ev}
              </label>
            ))}
          </div>
          <label style={s.small}>
            Runs, per event
            <textarea style={{ ...s.input, display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 54, marginTop: 4 }} value={command} onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label style={s.small}>
            In the folder <input style={{ ...s.input, width: 260 }} value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder it runs in" />
          </label>
          {made && made.id === pick ? (
            <>
              <p style={s.small}>{made.name}'s token is in these, shown this once. Give claude the shipcue tools in that folder first:</p>
              <Copy text={mcpLine(endpoint, made.token)} />
            </>
          ) : (
            <p style={s.small}>Put {agent?.name}'s token (shown once when it was connected) where it says so, or create a new agent here to fill it in.</p>
          )}
          <div style={s.pills} role="tablist" aria-label="How to run it">
            {[
              ['cmd', 'Command'],
              ['mac', 'macOS (launchd)'],
              ['linux', 'Linux (systemd)'],
            ].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={os === k} style={{ ...s.pill, ...(os === k ? s.pillOn : {}) }} onClick={() => setOs(k)}>
                {label}
              </button>
            ))}
          </div>
          <Copy text={os === 'cmd' ? listenCommand(opts) : os === 'mac' ? launchdInstall(opts) : systemdInstall(opts)} />
          <p style={s.small}>
            {os === 'cmd'
              ? 'Runs while the terminal is open. Use launchd or systemd to keep it running after you log out and restart it if it stops.'
              : os === 'mac'
                ? `Keeps running (KeepAlive) and starts at login; logs go to ~/Library/Logs/shipcue-listen-${slug(p.name)}.log.`
                : 'Restarts whenever it stops and keeps running after you log out (linger).'}{' '}
            Want it instant instead of every 15 seconds? Point the webhook under Forward reports at that machine (say a Tailscale Funnel address) and the project pushes
            each event to it as signed JSON.
          </p>
        </>
      )}
    </section>
  );
}

/** The hosted agent (shipcue report 3d2dded6): shipcue-agent triages on OpenAI and leaves a note. */
function Hosted({ detail, save }) {
  const p = detail.project;
  const owner = detail.role === 'owner';
  const h = detail.hosted ?? { available: false, name: 'shipcue-agent', dailyLimit: null };
  return (
    <section style={s.card}>
      <h3 style={{ margin: 0 }}>4. Hosted agent</h3>
      <p style={s.small}>
        {h.name} runs on shipcue (OpenAI), nothing to install. Assign a report to it in the CueLog and it adds a note: a summary, the likely area, a suggested priority
        with a reason, steps to reproduce or what is missing, and a short plan for a coding agent, with one-click Apply chips (and Merge when it looks like a duplicate of an open report). Then it puts the report back in the queue. It never changes code.
        {h.dailyLimit ? ` Up to ${h.dailyLimit} a day per project.` : ''}
      </p>
      {!h.available && <p style={s.small}>Not available on this server yet.</p>}
      <label style={{ ...s.small, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={p.hostedAgent} disabled={!owner || (!h.available && !p.hostedAgent)} onChange={(e) => save({ hostedAgent: e.target.checked })} /> Turn on{' '}
        {h.name}
      </label>
      <label style={{ ...s.small, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={p.hostedAutoTriage} disabled={!owner || !p.hostedAgent} onChange={(e) => save({ hostedAutoTriage: e.target.checked })} /> Triage every
        new report, not only the ones assigned to it
      </label>
      {!owner && <p style={s.small}>Owners turn it on.</p>}
    </section>
  );
}

/** The activity digest (shipcue report 5f4d339b): one summary an hour or a day instead of a message per event. */
function Digest({ detail, save }) {
  const p = detail.project;
  const d = detail.digest ?? { available: false, email: false };
  const where = p.digestTo === 'email' ? "the owner's email" : p.slackConnected ? 'Slack' : 'Slack (connect it above first)';
  return (
    <section style={s.card}>
      <h3 style={{ margin: 0 }}>6. Digest</h3>
      <p style={s.small}>
        One summary instead of a message per event: what was filed, fixed (with the fix line and PR), reopened, claims stuck past their lease, how many are still open
        and the oldest waiting. Quiet periods send nothing. Never who filed it or the app snapshot.
      </p>
      {!d.available && <p style={s.small}>Not available on this server yet.</p>}
      <div style={s.row}>
        <select style={s.input} value={p.digestEvery} disabled={!d.available && p.digestEvery === 'off'} onChange={(e) => save({ digestEvery: e.target.value })} aria-label="How often">
          <option value="off">Off</option>
          <option value="hour">Hourly</option>
          <option value="day">Daily</option>
        </select>
        <select style={s.input} value={p.digestTo} onChange={(e) => save({ digestTo: e.target.value })} aria-label="Where it goes">
          <option value="slack">To the Slack channel above</option>
          {(d.email || p.digestTo === 'email') && <option value="email">To the owner's email</option>}
        </select>
      </div>
      {p.digestEvery !== 'off' && (
        <p style={s.small}>
          Goes to {where} {p.digestEvery === 'hour' ? 'every hour' : 'once a day'}
          {p.digestSentAt ? `; last period ended ${new Date(p.digestSentAt).toLocaleString()}` : ''}.
        </p>
      )}
    </section>
  );
}

function Setup({ detail, reload, onProjects }) {
  const p = detail.project;
  const owner = detail.role === 'owner';
  const endpoint = `${ORIGIN}${API}/p/${p.publicKey}`;
  const [agentName, setAgentName] = useState('');
  const [mode, setMode] = useState('');
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);
  const [origins, setOrigins] = useState(p.allowedOrigins.join('\n'));
  const [lease, setLease] = useState(p.leaseSeconds == null ? '' : String(Math.round(p.leaseSeconds / 60)));
  const [stale, setStale] = useState(String(p.staleDays));
  const [name, setName] = useState(p.name);
  const [areas, setAreas] = useState(p.areas.map((a) => `${a.value}: ${a.label}`).join('\n'));
  const [saved, setSaved] = useState(false);
  const [slackUrl, setSlackUrl] = useState('');
  const [hookUrl, setHookUrl] = useState(p.webhookUrl ?? '');
  const [hookSecret, setHookSecret] = useState(null);
  const [ghSecret, setGhSecret] = useState(null);
  const run = async (fn) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err.message);
    }
  };
  const save = (patch) =>
    run(async () => {
      await api(`/projects/${p.id}/settings`, patch);
      if (patch.name !== undefined && patch.name !== p.name) await onProjects();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error && <p style={s.error}>{error}</p>}
      <section style={s.card}>
        <h3 style={{ margin: 0 }}>1. Add the button to your app</h3>
        <Copy text={`pnpm add https://github.com/cyu60/shipcue/releases/download/v${VERSION}/shipcue-${VERSION}.tgz`} />
        <Copy text={`import { ReportButton } from 'shipcue/react';\n\n<ReportButton endpoint="${endpoint}" types={['bug', 'feature']} />`} />
        <p style={s.small}>The button can only file reports from the sites you list here, one per line.</p>
        <textarea style={{ ...s.input, minHeight: 60 }} disabled={!owner} placeholder="https://app.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
        {owner && (
          <div>
            <Button onClick={() => save({ allowedOrigins: origins.split('\n').map((o) => o.trim()).filter(Boolean) })}>{saved ? 'Saved' : 'Save sites'}</Button>
          </div>
        )}
      </section>

      <section style={s.card}>
        <h3 style={{ margin: 0 }}>2. Connect your agents</h3>
        <p style={s.small}>Each agent gets its own token, so the CueLog shows which one holds what. A token is shown once.</p>
        {detail.role !== 'viewer' && (
          <div style={s.row}>
            <input style={s.input} placeholder="claude-code" value={agentName} onChange={(e) => setAgentName(e.target.value.toLowerCase())} />
            <select style={s.input} value={mode} onChange={(e) => setMode(e.target.value)} aria-label="What it takes">
              <option value="">Takes unassigned work: project default ({p.agentPull ? 'yes' : 'no'})</option>
              <option value="pull">Takes unassigned work</option>
              <option value="push">Only what is assigned to it</option>
            </select>
            <Button
              ink
              onClick={() =>
                run(async () => {
                  const r = await api(`/projects/${p.id}/agents`, { name: agentName, pull: mode === 'pull' ? true : mode === 'push' ? false : null });
                  setToken({ name: r.agent.name, token: r.token });
                  setAgentName('');
                })
              }
            >
              Connect
            </Button>
          </div>
        )}
        {token && <Copy text={mcpLine(endpoint, token.token)} />}
        {detail.agents.length > 0 && (
          <table style={s.table}>
            <tbody>
              {detail.agents.map((a) => (
                <tr key={a.id}>
                  <td style={s.td}>🤖 {a.name}</td>
                  <td style={{ ...s.td, color: 'var(--muted)' }}>connected by {a.ownerName}</td>
                  <td style={{ ...s.td, color: 'var(--muted)' }}>{a.pull === null ? 'project default' : a.pull ? 'takes unassigned work' : 'assigned work only'}</td>
                  <td style={{ ...s.td, color: 'var(--muted)' }}>{a.lastSeenAt ? `seen ${new Date(a.lastSeenAt).toLocaleString()}` : 'not seen yet'}</td>
                  <td style={s.td}>
                    {(owner || a.ownerUserId === detail.me) && <Button onClick={() => run(() => api(`/projects/${p.id}/agents/${a.id}/revoke`, {}))}>Disconnect</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detail.role !== 'viewer' && <Listener detail={detail} endpoint={endpoint} run={run} />}

      <Hosted detail={detail} save={save} />

      {owner && (
        <section style={s.card}>
          <h3 style={{ margin: 0 }}>5. Forward reports</h3>
          <p style={s.small}>Announce this project's reports in a Slack channel, or send them to your own endpoint as signed JSON. Neither ever includes who filed it or the app snapshot in Slack.</p>
          <div style={s.row}>
            <input style={{ ...s.input, flex: 1 }} placeholder={p.slackConnected ? 'Slack is connected. Paste a new URL to change it' : 'https://hooks.slack.com/services/…'} value={slackUrl} onChange={(e) => setSlackUrl(e.target.value)} />
            <Button onClick={() => save({ slackWebhookUrl: slackUrl.trim() }).then(() => setSlackUrl(''))} disabled={!slackUrl.trim()}>
              {p.slackConnected ? 'Change' : 'Connect Slack'}
            </Button>
            {p.slackConnected && <Button onClick={() => save({ slackWebhookUrl: null })}>Disconnect</Button>}
          </div>
          <div style={s.row}>
            <input style={{ ...s.input, flex: 1 }} placeholder="https://your.app/hooks/shipcue" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
            <Button
              onClick={() =>
                run(async () => {
                  const r = await api(`/projects/${p.id}/settings`, { webhookUrl: hookUrl.trim() || null });
                  setHookSecret(r.webhookSecret ?? null);
                })
              }
            >
              {hookUrl.trim() ? 'Save webhook' : 'Remove webhook'}
            </Button>
          </div>
          {hookSecret && (
            <>
              <p style={s.small}>Signing secret, shown once. Check each request's x-shipcue-signature with it (signBody in shipcue/server).</p>
              <Copy text={hookSecret} />
            </>
          )}
          <div style={s.row} role="group" aria-label="Events to forward">
            {[['report.filed', 'Filed'],['report.claimed', 'Claimed'],['report.assigned', 'Assigned'],['report.review', 'In review'],['report.closed', 'Closed'],['report.reopened', 'Reopened']].map(([ev, label]) => (
              <label key={ev} style={{ ...s.small, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={p.notifyEvents.includes(ev)}
                  onChange={(e) => save({ notifyEvents: e.target.checked ? [...p.notifyEvents, ev] : p.notifyEvents.filter((x) => x !== ev) })}
                />
                {label}
              </label>
            ))}
          </div>
        </section>
      )}

      {owner && <Digest detail={detail} save={save} />}

      {owner && (
        <section style={s.card}>
          <h3 style={{ margin: 0 }}>7. Close the loop with GitHub</h3>
          <p style={s.small}>
            A pull request whose title, body or branch names a report (its id or first 8 characters) moves it to In review; merging it marks it Fixed. In your repository: Settings → Webhooks → Add
            webhook, this Payload URL, content type application/json, the secret below, and only the Pull requests event.
          </p>
          <Copy text={`${endpoint}/github`} />
          <div style={s.row}>
            <Button
              onClick={() =>
                run(async () => {
                  const r = await api(`/projects/${p.id}/settings`, { githubWebhook: true });
                  setGhSecret(r.githubSecret ?? null);
                })
              }
            >
              {p.githubConnected ? 'New secret' : 'Turn on'}
            </Button>
            {p.githubConnected && (
              <Button
                onClick={() =>
                  run(async () => {
                    await api(`/projects/${p.id}/settings`, { githubWebhook: false });
                    setGhSecret(null);
                  })
                }
              >
                Turn off
              </Button>
            )}
          </div>
          {ghSecret && (
            <>
              <p style={s.small}>Webhook secret, shown once. Paste it into GitHub's Secret field.</p>
              <Copy text={ghSecret} />
            </>
          )}
        </section>
      )}

      {owner && (
        <section style={s.card}>
          <h3 style={{ margin: 0 }}>Settings</h3>
          <label style={s.small}>
            Name <input style={s.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Project name" />
          </label>
          <div style={s.row}>
            <label style={s.small}>
              Agent claims run out after{' '}
              <input style={{ ...s.input, width: 80 }} inputMode="numeric" value={lease} onChange={(e) => setLease(e.target.value)} placeholder="never" /> minutes without a
              heartbeat
            </label>
          </div>
          <div style={s.row}>
            <label style={s.small}>
              A person's claim shows stale after <input style={{ ...s.input, width: 60 }} inputMode="numeric" value={stale} onChange={(e) => setStale(e.target.value)} /> days
            </label>
          </div>
          <label style={{ ...s.small, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={p.agentPull} onChange={(e) => save({ agentPull: e.target.checked })} /> Agents take unassigned work by default
          </label>
          <label style={{ ...s.small, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={p.publicBoard} onChange={(e) => save({ publicBoard: e.target.checked })} /> Public CueLog (queue and changelog, no reporters or
            attachments) at {endpoint}/board
          </label>
          <p style={s.small}>Areas of your app, one per line as value: Label</p>
          <textarea style={{ ...s.input, minHeight: 60 }} placeholder="editor: Editor" value={areas} onChange={(e) => setAreas(e.target.value)} />
          <div>
            <Button
              onClick={() =>
                save({
                  name,
                  leaseSeconds: lease.trim() ? Math.round(Number(lease) * 60) : null,
                  staleDays: Number(stale),
                  areas: areas
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .map((l) => {
                      const [value, ...label] = l.split(':');
                      return { value: value.trim().toLowerCase(), label: (label.join(':') || value).trim() };
                    }),
                })
              }
            >
              {saved ? 'Saved' : 'Save settings'}
            </Button>
          </div>
        </section>
      )}

      {owner && (
        <section style={s.card}>
          <h3 style={{ margin: 0 }}>Key and project</h3>
          <p style={s.small}>A new key retires the old one at once: the button files nothing until your app has the new endpoint.</p>
          <div style={s.row}>
            <Button
              onClick={() => {
                if (window.confirm('Make a new key? The button stops working until you deploy the new endpoint.')) run(() => api(`/projects/${p.id}/rotate-key`, {}));
              }}
            >
              New key
            </Button>
            <Button
              style={{ color: '#B91C1C' }}
              onClick={() => {
                if (!window.confirm(`Delete ${p.name} for the whole team? Its queue, button key and agent tokens stop working.`)) return;
                setError(null);
                api(`/projects/${p.id}/delete`, {})
                  .then(() => onProjects())
                  .catch((err) => setError(err.message));
              }}
            >
              Delete project
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function Team({ detail, reload }) {
  const p = detail.project;
  const owner = detail.role === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error && <p style={s.error}>{error}</p>}
      <section style={s.card}>
        <h3 style={{ margin: 0 }}>Team</h3>
        <table style={s.table}>
          <tbody>
            {detail.members.map((m) => (
              <tr key={m.id}>
                <td style={s.td}>{m.name}</td>
                <td style={{ ...s.td, color: 'var(--muted)' }}>{m.email}</td>
                <td style={s.td}>
                  {owner ? (
                    <select style={s.input} value={m.role} onChange={(e) => run(() => api(`/projects/${p.id}/members/${m.id}/role`, { role: e.target.value }))}>
                      <option value="owner">Owner</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td style={s.td}>{owner && <Button onClick={() => run(() => api(`/projects/${p.id}/members/${m.id}/remove`, {}))}>Remove</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={s.small}>Owners run the project; members see and work the queue; viewers only see it.</p>
      </section>
      {owner && (
        <section style={s.card}>
          <h3 style={{ margin: 0 }}>Invite</h3>
          <div style={s.row}>
            <input style={s.input} type="email" placeholder="their@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select style={s.input} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
              <option value="owner">Owner</option>
            </select>
            <Button
              ink
              onClick={() =>
                run(async () => {
                  await api(`/projects/${p.id}/invites`, { email, role });
                  setEmail('');
                })
              }
            >
              Invite
            </Button>
          </div>
          <p style={s.small}>
            Send them {ORIGIN}/app/ and ask them to sign up with that email. They land in {p.name} as soon as they sign in.
          </p>
          {detail.invites.length > 0 && (
            <table style={s.table}>
              <tbody>
                {detail.invites.map((i) => (
                  <tr key={i.id}>
                    <td style={s.td}>{i.email}</td>
                    <td style={{ ...s.td, color: 'var(--muted)' }}>{i.role}, waiting</td>
                    <td style={s.td}>
                      <Button onClick={() => run(() => api(`/projects/${p.id}/invites/${i.id}/revoke`, {}))}>Cancel</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function Project({ id, me, onProjects }) {
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('cuelog');
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    const d = await api(`/projects/${id}`);
    setDetail({ ...d, me: me.user.id });
  }, [id, me.user.id]);
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, [reload]);
  if (error) return <p style={s.error}>{error}</p>;
  if (!detail) return <p style={s.small}>Loading…</p>;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={s.pills} role="tablist">
        {[
          ['cuelog', 'CueLog'],
          ['setup', 'Setup'],
          ['team', 'Team'],
        ].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} style={{ ...s.pill, ...(tab === k ? s.pillOn : {}) }} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'cuelog' && (
        <div style={{ ...s.card, display: 'block' }}>
          <CueLogTable syncUrl hotkeys endpoint={`${API}/p/${detail.project.publicKey}`} staleDays={detail.project.staleDays} areas={detail.project.areas} />
        </div>
      )}
      {tab === 'setup' && <Setup detail={detail} reload={reload} onProjects={onProjects} />}
      {tab === 'team' && <Team detail={detail} reload={reload} />}
    </div>
  );
}

function App() {
  const [me, setMe] = useState(undefined);
  const [current, setCurrent] = useState(() => new URLSearchParams(window.location.search).get('p'));
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const who = await api('/me');
      // Sent here to sign in from a page's report button: go back there.
      const next = new URLSearchParams(window.location.search).get('next');
      // /app/mine/ (My reports) is the one /app page that sends people here to sign in.
      if (next && next.startsWith('/') && !next.startsWith('//') && (!next.startsWith('/app') || next.startsWith('/app/mine/'))) {
        window.location.assign(next);
        return;
      }
      setMe(who);
    } catch (err) {
      if (err.status === 401) setMe(null);
      else throw err;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const pick = (id) => {
    setCurrent(id);
    setCreating(false);
    const url = new URL(window.location.href);
    url.searchParams.set('p', id);
    window.history.replaceState(null, '', url);
  };

  if (me === undefined) return <p style={s.small}>Loading…</p>;
  if (me === null) return <Auth onIn={load} />;
  const project = me.projects.find((p) => p.id === current) ?? me.projects[0];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <div style={s.row}>
          {me.projects.length > 0 && (
            <select style={s.input} aria-label="Project" value={project?.id} onChange={(e) => pick(e.target.value)}>
              {me.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {me.canCreate && <Button onClick={() => setCreating(true)}>New project</Button>}
        </div>
        <div style={s.row}>
          <span style={s.small}>{me.user.email}</span>
          <a href="/app/mine/" style={s.small}>My reports</a>
          <Button onClick={() => api('/auth/sign-out', {}).then(() => setMe(null))}>Sign out</Button>
        </div>
      </div>
      {creating || (!project && me.canCreate) ? (
        <NewProject
          onMade={async (id) => {
            await load();
            pick(id);
          }}
        />
      ) : project ? (
        <Project key={project.id} id={project.id} me={me} onProjects={load} />
      ) : (
        <div style={{ ...s.card, maxWidth: 520 }}>
          <h2 style={{ margin: 0 }}>No projects yet</h2>
          <p style={s.small}>
            shipcue Cloud is invite-only for now. Ask a team to invite {me.user.email}, or ask us to join the beta with the ship button at the bottom right.
          </p>
        </div>
      )}
    </div>
  );
}

const el = document.getElementById('shipcue-app');
if (el) createRoot(el).render(<App />);
