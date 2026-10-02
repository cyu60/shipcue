"""Builds the static site: wraps each page body in the shared head, header and footer."""
from pathlib import Path

ROOT = Path(__file__).parent
HEAD = (ROOT / "_head.txt").read_text()
EMAIL = "chinatchinat123@gmail.com"
NAV = [("/", "Home"), ("/docs/", "Docs"), ("/cloud/", "Cloud"), ("/blog/", "Blog"), ("/contact/", "Contact")]


def page(path, title, description, body, current):
    here = ' aria-current="page"'
    nav = "".join(f'<a href="{href}"{here if href == current else ""}>{label}</a>' for href, label in NAV)
    html = f"""<!doctype html>
<html lang="en">
<head>
{HEAD}<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="https://fixqueue.vercel.app/assets/banner.png">
</head>
<body>
<div class="wrap">
<header class="site-head"><a class="brand" href="/">fixqueue</a><nav class="nav" aria-label="Main">{nav}</nav></header>
<main>
{body}
</main>
<footer class="site-foot"><span>fixqueue is open source under the MIT license.</span><span><a href="mailto:{EMAIL}">{EMAIL}</a></span></footer>
</div>
</body>
</html>
"""
    out = ROOT / path
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)


HOME = """
<section class="hero">
  <h1>Bug reports your coding agents can fix</h1>
  <p class="lede">A report button for your app, a queue in your own Postgres, and an MCP server so Claude Code or Codex can take the most urgent report, fix it and close it with the PR link.</p>
  <div class="actions"><a class="btn btn-ink" href="/docs/">Read the docs</a><a class="btn btn-plain" href="/blog/agents-should-read-your-bug-reports/">Why we built it</a></div>

  <div class="demo" aria-label="Try the queue">
    <div class="demo-bar">
      <div class="serving" aria-live="polite"><span>Now serving</span><b id="serving">--</b><span id="agent">nobody yet</span></div>
      <div class="demo-actions">
        <button class="btn btn-plain" id="file" type="button">File a report</button>
        <button class="btn btn-ink" id="claim" type="button">Claim next</button>
        <button class="btn btn-plain" id="fix" type="button">Close as fixed</button>
      </div>
    </div>
    <ol class="strip" id="strip"></ol>
    <p class="demo-log" id="log">Try it: file a few reports, then claim one the way an agent would. The most urgent goes first.</p>
  </div>
</section>

<h2>How it works</h2>
<div class="flow">
  <div><h3>Someone reports it</h3><p>The button opens a small form: bug or feature, what happened, how bad it is, where in the app. People can paste a screenshot. The page address, browser and a snapshot of app state you choose come along automatically.</p></div>
  <div><h3>It joins the queue</h3><p>Reports go into one table in your own Postgres, ordered by priority and then by age. Nothing goes to a third-party dashboard.</p></div>
  <div><h3>An agent fixes it</h3><p>The MCP server hands an agent the top report as a ready-to-run task. Claims are atomic, so several agents can work the queue at once and never take the same report.</p></div>
</div>

<h2>Add it in three steps</h2>
<div class="prose">
<p>Create the table, mount one handler, drop in the button.</p>
<pre><code>import { ReportButton } from 'fixqueue/react';

&lt;ReportButton
  areas={[{ value: 'editor', label: 'Editor' }]}
  diagnostics={() =&gt; ({ route: location.pathname })}
/&gt;</code></pre>
<p><a href="/docs/">Full setup in the docs</a></p>
</div>

<script>
(() => {
  const kinds = [
    ['Bug', 'blocking', 'Editor'], ['Feature', 'low', 'Search'], ['Bug', 'high', 'Sign-in'],
    ['Bug', 'medium', 'Journals'], ['Feature', 'medium', 'Sharing'], ['Bug', 'low', 'Settings'],
  ];
  const rank = { blocking: 3, high: 2, medium: 1, low: 0 };
  const label = { blocking: 'Blocking', high: 'High', medium: 'Medium', low: 'Low' };
  let next = 41, i = 0;
  const q = [
    { n: 39, type: 'Bug', pr: 'high', area: 'Editor', status: 'fixed' },
    { n: 40, type: 'Feature', pr: 'medium', area: 'Search', status: 'open' },
  ];
  const $ = (id) => document.getElementById(id);
  const log = (t) => ($('log').textContent = t);

  function render(fresh) {
    const strip = $('strip');
    strip.innerHTML = '';
    const order = [...q].sort((a, b) => (a.status === 'fixed') - (b.status === 'fixed') || (b.status === 'claimed') - (a.status === 'claimed') || rank[b.pr] - rank[a.pr] || a.n - b.n);
    for (const r of order) {
      const li = document.createElement('li');
      li.className = 't ' + r.status + (r.n === fresh ? ' enter' : '');
      li.innerHTML = `<div class="k">${r.type}</div><div><div class="n">${r.n}</div><div class="p">${r.status === 'fixed' ? 'Fixed' : label[r.pr] + ' · ' + r.area}</div></div>`;
      strip.appendChild(li);
    }
    const claimed = q.find((r) => r.status === 'claimed');
    $('serving').textContent = claimed ? claimed.n : '--';
    $('agent').textContent = claimed ? 'claude-code' : 'nobody yet';
  }

  $('file').onclick = () => {
    const [type, pr, area] = kinds[i++ % kinds.length];
    const n = next++;
    q.push({ n, type, pr, area, status: 'open' });
    render(n);
    log(`#${n} filed: ${type.toLowerCase()} in ${area}, ${label[pr].toLowerCase()} priority. Page, browser and app snapshot attached.`);
  };
  $('claim').onclick = () => {
    if (q.some((r) => r.status === 'claimed')) return log('Close the current report first. One agent, one report at a time.');
    const open = q.filter((r) => r.status === 'open').sort((a, b) => rank[b.pr] - rank[a.pr] || a.n - b.n);
    if (!open.length) return log('The queue is empty. File a report first.');
    open[0].status = 'claimed';
    render();
    log(`claude-code claimed #${open[0].n}, the most urgent open report, and got it as a task prompt.`);
  };
  $('fix').onclick = () => {
    const r = q.find((x) => x.status === 'claimed');
    if (!r) return log('Nothing is claimed. Claim the next report first.');
    r.status = 'fixed';
    render();
    log(`#${r.n} closed as fixed with the PR link. The reporter can see it is done.`);
  };
  render();
})();
</script>
"""

DOCS = """
<div class="prose">
<h1>Docs</h1>
<p class="lede">Set up fixqueue in a Next.js app in about ten minutes. The handler is a plain <code>(Request) =&gt; Response</code> function, so it also runs in Hono, Remix, Bun, Deno and Cloudflare Workers.</p>
<div class="note">fixqueue is in early preview. The npm package and the public repository open soon. <a href="/contact/">Ask for early access</a>.</div>

<h2>1. Create the table</h2>
<p>Run <code>sql/schema.sql</code> on your database. It creates one table, <code>fixqueue_reports</code>, and an index that keeps the queue fast. It works on Supabase, InsForge, Neon, RDS and plain Postgres.</p>

<h2>2. Mount the handler</h2>
<p>In <code>app/api/fixqueue/[...path]/route.ts</code>:</p>
<pre><code>import { Pool } from 'pg';
import { createFixqueueHandler, postgresStore } from 'fixqueue/server';
import { resolveConfig } from 'fixqueue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const handler = createFixqueueHandler({
  store: postgresStore(pool),
  config: resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }] }),
  getReporter: async (req) =&gt; (await getSession(req))?.email ?? null,
  requireReporter: true,
  agentToken: process.env.FIXQUEUE_TOKEN,
  onReport: async (report) =&gt; { /* email the team, post to Slack */ },
});

export { handler as GET, handler as POST };</code></pre>
<p>Screenshots are stored as small data URLs unless you pass <code>saveScreenshot(file, key)</code> to upload them to S3 or Supabase Storage. A failure inside <code>onReport</code> never fails the report.</p>

<h2>3. Add the button</h2>
<pre><code>import { ReportButton } from 'fixqueue/react';

&lt;ReportButton
  areas={[{ value: 'editor', label: 'Editor' }]}
  accentColor="#16203A"
  diagnostics={() =&gt; ({ route: location.pathname, lastAction: store.lastAction })}
/&gt;</code></pre>
<ul>
  <li><code>variant="inline"</code> puts a small button in your header, which works better on phones where a floating bubble covers the controls.</li>
  <li><code>submit={(form) =&gt; action(form)}</code> sends through a Next.js server action instead of <code>fetch</code>.</li>
  <li><code>diagnostics</code> is a snapshot for whoever fixes the report. Keep it under 64 KB. If it throws, the report still goes through.</li>
</ul>

<h2>4. Connect an agent</h2>
<pre><code>claude mcp add fixqueue \\
  -e FIXQUEUE_URL=https://your.app/api/fixqueue \\
  -e FIXQUEUE_TOKEN=... \\
  -- npx fixqueue-mcp</code></pre>
<p>The agent gets six tools: <code>list_reports</code>, <code>claim_next_report</code>, <code>get_report</code>, <code>claim_report</code>, <code>release_report</code> and <code>close_report</code>. A claimed report arrives as a task prompt with the description, page, screenshots, app snapshot and what to do next: reproduce, write a failing test, fix, close with the PR link.</p>

<h2>HTTP API</h2>
<p>Everything except filing a report needs <code>Authorization: Bearer $FIXQUEUE_TOKEN</code>. Leave <code>agentToken</code> unset to switch the agent API off.</p>
<pre><code>POST /reports                 file a report (multipart form, from the button)
GET  /reports?status=open     the queue, most urgent first
GET  /reports/:id             one report plus its task prompt
POST /reports/next/claim      take the most urgent open report (204 when empty)
POST /reports/:id/claim       take a specific report (409 if someone has it)
POST /reports/:id/release     give it back to the queue
POST /reports/:id/close       { "status": "fixed" | "wontfix", "resolution": "PR link" }</code></pre>

<h2>What a report holds</h2>
<ul>
  <li>Type: bug or feature request</li>
  <li>Priority: low, medium, high or blocking</li>
  <li>Area: the parts of your app you list, plus Other</li>
  <li>Description, 10 to 4,000 characters</li>
  <li>Up to 3 screenshots, 5 MB each, shrunk in the browser first</li>
  <li>Page address, browser and your app snapshot</li>
  <li>Status: open, claimed, fixed or won't fix, with who claimed it and the resolution</li>
</ul>
</div>
"""

CLOUD = """
<div class="prose">
<h1>Cloud</h1>
<p class="lede">The same queue without running a database: add the button, get a hosted queue, connect your agents.</p>
<div class="note">fixqueue Cloud is planned, not built yet. Self-hosting is the way to use fixqueue today. <a href="/contact/">Tell us you want it</a> and we will build it with you.</div>
<h2>What it would add</h2>
<ul>
  <li>A hosted queue and screenshot storage, so you only add the button</li>
  <li>A web view of the queue for people who do not live in a terminal</li>
  <li>Sending reports on to GitHub Issues, Linear, Slack and email</li>
  <li>An email to the reporter when their report is fixed</li>
</ul>
<h2>What stays the same</h2>
<p>The button, the API and the MCP tools are the same as the open source package, so you can move between hosted and self-hosted at any time.</p>
</div>
"""

BLOG = """
<div class="prose">
<h1>Blog</h1>
<ul class="post-list">
  <li><a href="/blog/agents-should-read-your-bug-reports/">Your bug report button should feed your agents</a><div class="meta">October 1, 2026 · Chinat Yu</div></li>
</ul>
</div>
"""

POST = """
<article class="prose">
<h1>Your bug report button should feed your agents</h1>
<p class="meta">October 1, 2026 · Chinat Yu</p>

<p>I think that most of us build the bug report button last, and honestly it shows. In MentorMates it was a link in the support menu that opened a Google Form. Someone would write "the page is broken" and I would have no idea which page, which browser, or what they had clicked before it broke.</p>

<p>When we built the internal dashboard for Stanford Founders, I took it more seriously. The button let people pick bug or feature request, say how bad it was and where it happened, and paste a screenshot straight into the text box. It attached the page address on its own. Reports landed on our task board, and the team got an email. People actually used it, which surprised me more than anything.</p>

<p>Then I started building an outliner, and the first thing I wrote for it, before most of the editor was done, was the same button again. That was the moment I realised I kept rebuilding the same five parts: a button, a form, the context that comes along automatically, somewhere to store it, and somewhere for it to go.</p>

<h2>The part that changed</h2>
<p>What is different now is who reads the report. More and more of my fixes start with Claude Code, and a good bug report is exactly the thing an agent needs: what happened, where, on which browser, with a screenshot and a snapshot of the app's state. The report is basically a task prompt already. It just never reached the agent.</p>

<p>So fixqueue treats the inbox as a queue. Reports sit in your own Postgres, most urgent first. An agent connects over MCP, claims the top report, gets it as a task (reproduce it, write a failing test, fix it), and closes it with the PR link. The claim is atomic, so you can point several agents at the queue and none of them will ever pick up the same report.</p>

<h2>Why self-hosted</h2>
<p>There are good hosted feedback tools already. I wanted something that lives in the database I already have, that I can read with SQL, and that does not need another login for the team. It is one table, one handler and one React component.</p>

<h2>What is next</h2>
<p>The first version is built and tested. Next I am moving my own apps onto it, starting with the outliner, and then opening it up properly. If you want to try it early, or you have a queue of reports you wish an agent would just handle, <a href="/contact/">get in touch</a>. I would love to hear how you would use it.</p>
</article>
"""

CONTACT = f"""
<div class="prose">
<h1>Contact</h1>
<p class="lede">Questions, early access, or a report queue you want an agent working through? Email Chinat.</p>
<p><a class="btn btn-ink" href="mailto:{EMAIL}?subject=fixqueue">Email {EMAIL}</a></p>
<h2>Good things to include</h2>
<ul>
  <li>What your app is built with: framework, database, auth</li>
  <li>Where your bug reports go today</li>
  <li>Whether you want to self-host or would rather use the hosted Cloud</li>
</ul>
</div>
"""

page("index.html", "fixqueue: bug reports your coding agents can fix", "A report button, a queue in your own Postgres, and an MCP server so coding agents can fix what people report.", HOME, "/")
page("docs/index.html", "Docs · fixqueue", "Set up fixqueue: the table, the handler, the button and the agent tools.", DOCS, "/docs/")
page("cloud/index.html", "Cloud · fixqueue", "fixqueue Cloud: the same queue without running a database. Planned.", CLOUD, "/cloud/")
page("blog/index.html", "Blog · fixqueue", "Notes on building fixqueue.", BLOG, "/blog/")
page("blog/agents-should-read-your-bug-reports/index.html", "Your bug report button should feed your agents · fixqueue", "Why fixqueue treats the bug report inbox as a queue that agents work from.", POST, "/blog/")
page("contact/index.html", "Contact · fixqueue", "Get in touch about fixqueue.", CONTACT, "/contact/")
print("built")
