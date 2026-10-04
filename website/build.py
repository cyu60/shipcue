"""Builds the static site: wraps each page body in the shared head, header and footer."""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
VERSION = json.loads((ROOT.parent / "package.json").read_text())["version"]
EXT_DIR = ROOT.parent / "extension"
EXT_VERSION = json.loads((EXT_DIR / "manifest.json").read_text())["version"]

# The Chrome extension, zipped for the download page (shipcue report 879ec99b).
with zipfile.ZipFile(ROOT / "assets" / "shipcue-extension.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(EXT_DIR.rglob("*")):
        if f.is_file() and f.name != ".DS_Store":
            z.write(f, Path("shipcue-extension") / f.relative_to(EXT_DIR))
HEAD = (ROOT / "_head.txt").read_text()
NAV = [("/", "Home"), ("/use-cases/", "Use cases"), ("/docs/", "Docs"), ("/extension/", "Extension"), ("/cloud/", "Cloud"), ("/blog/", "Blog"), ("/cuelog/", "CueLog"), ("/contact/", "Contact")]


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
<meta property="og:image" content="https://shipcue.ibuildathing.com/assets/banner.png">
</head>
<body>
<div class="wrap">
<header class="site-head"><a class="brand" href="/" aria-label="shipcue home"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M14 6a6 6 0 0 1 6 6v3"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><rect x="2" y="15" width="20" height="4" rx="1"/></svg></span>shipcue</a><nav class="nav" aria-label="Main">{nav}</nav></header>
<main>
{body}
</main>
<footer class="site-foot"><span>shipcue is open source under the MIT license. <a href="https://github.com/cyu60/shipcue">Star it on GitHub</a></span><span><a href="/contact/">Contact us through shipcue</a></span></footer>
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

<h2>Who uses shipcue</h2>
<div class="flow">
  <div><h3>Hackathon teams</h3><p>Four people each running a couple of agents on one repo. One queue means no two agents fix the same bug, and nobody's fix quietly undoes someone else's.</p></div>
  <div><h3>Founders with early users</h3><p>Users report from inside the app with the page, browser and state attached. Your agent works the queue and you review the PRs.</p></div>
  <div><h3>Internal tools and betas</h3><p>Teammates and testers file what they hit while they click through. The most urgent report gets fixed first.</p></div>
</div>
<p><a href="/use-cases/">All use cases</a></p>

<h2>Add it in three steps</h2>
<div class="prose">
<p>Create the table, mount one handler, drop in the button.</p>
<pre><code>import { ReportButton } from 'shipcue/react';

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
<h1>shipcue docs</h1>
<p class="lede">Set up shipcue in a Next.js app in about ten minutes. The handler is a plain <code>(Request) =&gt; Response</code> function, so it also runs in Hono, Remix, Bun, Deno and Cloudflare Workers.</p>
<div class="note">shipcue is open source under the MIT license: <a href="https://github.com/cyu60/shipcue">github.com/cyu60/shipcue</a>. It is an early release, so <a href="/contact/">tell us</a> what breaks.</div>

<h2>0. Install shipcue</h2>
<pre><code>npm install shipcue</code></pre>
<p>Until it's on npm, install the prebuilt release from GitHub. Nothing builds on install, so it works with npm, pnpm and Vercel:</p>
<pre><code>pnpm add https://github.com/cyu60/shipcue/releases/download/v{VERSION}/shipcue-{VERSION}.tgz</code></pre>
<p>shipcue has three entry points: <code>shipcue</code> (config and the task prompt), <code>shipcue/server</code> (the handler and the Postgres store) and <code>shipcue/react</code> (the button). The MCP server runs as <code>npx shipcue-mcp</code>.</p>
<p>Stuck at any step? <code>npx shipcue doctor</code> says what is missing and how to fix it (see <a href="#doctor">Check your setup</a>). On shipcue Cloud, with no database of your own, <code>npx shipcue init --cloud pk_…</code> gives you the button for your project.</p>

<h2>1. Create the table</h2>
<p>Run <code>sql/schema.sql</code> on your database. It creates one table, <code>shipcue_reports</code>, and an index that keeps the queue fast. It works on Supabase, InsForge, Neon, RDS and plain Postgres.</p>

<h2>2. Mount the handler</h2>
<p>In <code>app/api/shipcue/[...path]/route.ts</code>:</p>
<pre><code>import { Pool } from 'pg';
import { createShipcueHandler, postgresStore } from 'shipcue/server';
import { resolveConfig } from 'shipcue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const handler = createShipcueHandler({
  store: postgresStore(pool),
  config: resolveConfig({ areas: [{ value: 'editor', label: 'Editor' }] }),
  getReporter: async (req) =&gt; (await getSession(req))?.email ?? null,
  requireReporter: true,
  agentToken: process.env.SHIPCUE_TOKEN,
  onReport: async (report) =&gt; { /* email the team, post to Slack */ },
});

export { handler as GET, handler as POST };</code></pre>
<p>Screenshots are stored as small data URLs unless you pass <code>saveScreenshot(file, key)</code> to upload them to S3 or Supabase Storage. A failure inside <code>onReport</code> never fails the report.</p>
<p><strong>Retry-safe filing.</strong> The panel sends an <code>idempotencyKey</code> with each report: one per draft, the same on every retry of it. When a send times out but the report was saved (a stalled database), the retry gets the same report back (same id, status 200) instead of filing a copy, and <code>onReport</code> and broadcasters hear about it once. <code>postgresStore</code> needs the "Upgrading from 0.26" block of <code>sql/schema.sql</code> (one nullable column and a unique index per project); until you run it, reports file as before without the protection.</p>
<p>Pass <code>saveVideo(file, key)</code> to let reporters attach a screen recording or video (WebM, MP4 or MOV, up to 40 MB) through <code>POST /reports/:id/video</code>. On hosts that cap request bodies, upload from the browser with the button's <code>uploadVideo</code> prop instead.</p>
<p><strong>Reporter portal.</strong> When <code>getReporter</code> reads a verified session (your auth cookie), add <code>reporterPortal: true</code>: <code>GET /mine</code> returns the signed-in reporter's own reports (status, fix line, PR, dates; never anyone else's, never diagnostics), and the panel's Yours list adds them, so it works on any device. Pins stay in each browser. Pair it with <code>emailReporter({ mineLink })</code>, and see <a href="/app/mine/">My reports</a> on shipcue's own site. Never turn it on when the reporter comes from the browser (the button's <code>reporter</code> prop): anyone could read anyone's reports. That is why shipcue Cloud projects do not offer it.</p>
<p><strong>Open what you sent.</strong> Each report sent from a browser is kept there in full (text, type, priority, area, page, picked-out context, screenshot and file counts, video yes or no, alt texts, time; never the screenshot or video data), the latest 50, under about 200 KB. Click a report in the panel's Yours list to open it, read-only, with the status, fix line and PR from <code>GET /mine</code> when the handler offers it; Back returns to the list. It works with a custom <code>submit</code> too.</p>
<p><strong>LocalReports.</strong> For a page whose button uses a custom <code>submit</code>, or when offline: <code>&lt;LocalReports /&gt;</code> from <code>shipcue/react</code> shows the reports sent from this browser and opens each one, from local storage only (no server calls). Props: <code>text</code> (the same keys as the button's), <code>renderContext</code>, <code>style</code>.</p>

<h2>3. Add the button</h2>
<pre><code>import { ReportButton } from 'shipcue/react';

&lt;ReportButton
  areas={[{ value: 'editor', label: 'Editor' }]}
  accentColor="#16203A"
  diagnostics={() =&gt; ({ route: location.pathname, lastAction: store.lastAction })}
/&gt;</code></pre>
<ul>
  <li><code>variant="inline"</code> puts a small button in your header, which works better on phones where a floating bubble covers the controls.</li>
  <li><code>submit={(form) =&gt; action(form)}</code> sends through a Next.js server action instead of <code>fetch</code>. The form carries <code>idempotencyKey</code> (one per draft, the same on a retry, new after a successful send): store it with a unique index and answer a repeat with the report already filed, and a stalled database can't leave copies.</li>
  <li><code>diagnostics</code> is a snapshot for whoever fixes the report. Keep it under 64 KB. If it throws, the report still goes through.</li>
  <li><code>reporter={user.email}</code> says who is signed in on your site. It goes with each report in the <code>x-shipcue-user</code> header; shipcue Cloud shows it as the reporter, and your own handler can read it in <code>getReporter</code>. Your site vouches for it.</li>
  <li>The panel has three tabs: Bug, Feature request and Agent task. An agent task is a direct instruction for an agent, and its prompt tells the agent the text came from whoever filed it. On a public page you may want <code>types={['bug', 'feature']}</code>.</li>
  <li>A small "Powered by shipcue · Star it on GitHub" line sits at the bottom of the panel. If shipcue helps you, a star really helps us; <code>watermark={false}</code> turns it off.</li>
  <li>Recent page errors are added to the snapshot as <code>recentErrors</code>. Turn this off with <code>captureErrors={false}</code>.</li>
  <li><code>uploadVideo</code> uploads a recording or video yourself; without it the button posts it to the handler.</li>
  <li><strong>Move it.</strong> Drag the floating button, or the panel by its title: the two move together, the panel stays on screen and settles above or below the button when you let go. Reset position (⌃⇧H / Alt+Shift+H) puts it back; <code>movable={false}</code> keeps it still.</li>
  <li><strong>Resize it.</strong> Drag the small grip on the panel's free corner to make it wider and taller; the text box takes the extra room. It stays on screen, never goes below the default size, and arrow keys work once the grip is focused. Kept in the browser; Reset position puts it back. <code>resizable={false}</code> keeps the default size.</li>
  <li><strong>Copy prompt for my agent.</strong> A small link in the panel's footer copies a prompt for Claude Code or Codex: the app, the page, the form's choices and your areas, what was typed so far, any context and the snapshot. The agent asks for what is missing, then files it with the MCP tool <code>file_report</code> or a ready <code>curl</code> to your endpoint.</li>
  <li><strong>Select area.</strong> The tile next to the screenshot tile (⌃⇧A / Alt+Shift+A) tints the page; drag a rectangle and it stays, to adjust before capturing: drag inside to move it, eight handles resize it, or type a width × height in the small toolbar under it. <strong>Capture</strong> (Enter) attaches it; <strong>Capture &amp; annotate</strong> opens it in an annotator; Esc cancels. The browser asks to share the tab only at Capture, once per open panel (the share is reused, and stops when the panel closes, the page hides, or after <code>captureKeepAlive</code> ms idle). The annotator has draw, arrow, box, highlight, text, blur, crop, colours, S/M/L lines, undo/redo and <strong>alt text</strong>, which is saved with the screenshot and shown on the board and the CueLog. The pencil on any pasted screenshot opens it there too. <code>dimOnOpen</code> (deprecated) tints the page while the panel is open, without blocking it.</li>
  <li><strong>Capture comes with the panel.</strong> When the floating panel opens, the page behind it is tinted: drag anywhere on it to select part of the page, adjust it and capture it, as Select area does, with no hotkey or button. A click or tap on the tint, or Esc, lifts it so the page is usable again (the panel stays open; a second Esc closes it); the Select area tile or ⌃⇧A brings it back. The panel stays above the tint and typing never captures. <code>captureOnOpen</code>: on by default for the floating panel (also with <code>trigger={false}</code>), off for <code>variant="inline"</code>; <code>captureOnOpen={false}</code> opts out.</li>
  <li><code>limits</code> (e.g. <code>{ maxScreenshots: 20 }</code>) sets how many screenshots and how big a video may be when you send reports with <code>submit</code>; with the built-in endpoint the button reads them from the handler's <code>resolveConfig</code>.</li>
  <li><code>text</code> puts your app's own words on anything the panel or board says, e.g. <code>{ seeReports: 'See your reports', send: 'Submit' }</code>; <code>DEFAULT_TEXT</code> lists every key.</li>
  <li><code>pastReportsHref</code> adds a Past reports link to the panel (<code>pastReportsLabel</code> changes its text).</li>
  <li><code>uploadVideo</code> uploads a video straight to your storage; post its URL to <code>/reports/:id/video</code> and accept it with the handler's <code>acceptVideoUrl</code>. Use it past Vercel's 4.5 MB request limit.</li>
  <li><code>resolveConfig({ allowFiles: true })</code> takes PDFs, logs and other files next to screenshots (never HTML, SVG or scripts).</li>
  <li>The panel shows the page it will attach, with a "don't attach" link.</li>
</ul>

<p><img src="/assets/report-button.png" alt="The shipcue panel: Bug, Feature request and Agent task tabs, priority, where, paste or drop screenshots, files or a video, screen recording, See the CueLog and Shortcuts links, and a Powered by shipcue line" width="408" style="max-width:100%;height:auto;border-radius:16px;margin-top:8px"></p>

<h2>Keyboard shortcuts</h2>
<p>The panel opens from the keyboard on any page, on the tab you ask for. Whatever is highlighted on the page comes along in an editable <b>Context</b> box (remove it with one click), so you can select a paragraph and turn it into an agent task in one go. When nothing is highlighted, <code>getContext={() =&gt; selectedRowsAsText()}</code> lets your app supply what is selected, like rows or blocks. Agents see it as its own Context section in the task prompt.</p>
<ul>
  <li><b>Agent task:</b> <code>⌘J</code> on a Mac, <code>Alt+Shift+J</code> elsewhere</li>
  <li><b>Bug:</b> <code>⌃B</code> on a Mac, <code>Alt+Shift+B</code> elsewhere</li>
  <li><b>Feature request:</b> <code>⌃F</code> on a Mac, <code>Alt+Shift+F</code> elsewhere</li>
  <li><b>Send:</b> <code>⌘↵</code> or <code>Ctrl+↵</code> on every tab (never mid-composition in an input method). <b>Close:</b> <code>Esc</code></li>
</ul>
<p>On Windows and Linux, Ctrl+J, Ctrl+B and Ctrl+F already belong to the browser and to editors, so shipcue stays off them. Pick your own with <code>hotkeys</code> ("Mod" is ⌘ on a Mac and Ctrl elsewhere), or pass <code>hotkeys={false}</code> to turn them off:</p>
<pre><code>&lt;ReportButton hotkeys={{ task: ['Mod+J'], bug: ['Mod+Shift+B'], feature: [] }} /&gt;</code></pre>
<p>To open the panel from your own menu or command palette, call <code>openReport('task')</code> from <code>shipcue/react</code>.</p>

<h2>Your own tabs</h2>
<p>Apps that already have their own flow, like an agent-task composer backed by their API, can put it in the same panel as a tab of its own. It gets the draft so far and a <code>close</code> function, and a hotkey or <code>openReport(id)</code> opens it:</p>
<pre><code>&lt;ReportButton
  types={['bug', 'feature']}
  hotkeys={{ agent: ['Mod+J'] }}
  extraTabs={[{
    id: 'agent',
    label: 'Agent task',
    title: 'New agent task',
    render: ({ text, context, close }) =&gt; &lt;TaskComposer draft={text} context={context} onDone={close} /&gt;,
  }]}
  onOpenChange={(open) =&gt; setPanelOpen(open)}
/&gt;</code></pre>
<p><code>closeReport()</code> closes the panel from anywhere. Already have a help or support button? Pass <code>trigger={false}</code> so shipcue draws no button of its own, and call <code>openReport('bug')</code> from your menu.</p>
<p>Only for testers? Pass <code>showParam="shipcue"</code> and shipcue stays off (no button, no hotkeys) until someone opens the page with <code>?shipcue=true</code>. It is remembered for that tab; <code>?shipcue=false</code> turns it off again.</p>

<h2 id="doctor">Check your setup</h2>
<p>Run this in your app's repo. It prints one ✓ or ✗ line per check, with the exact fix under each ✗, and exits non-zero if any fail:</p>
<pre><code>npx shipcue doctor
npx shipcue doctor --url https://your.app/api/shipcue</code></pre>
<ul>
  <li>shipcue is installed, and which version (and whether a newer release is out).</li>
  <li>No signed <code>release-assets.githubusercontent.com</code> URL in <code>pnpm-lock.yaml</code> or <code>package-lock.json</code>. It expires in about an hour and breaks every later deploy; the doctor prints the swap to the stable URL.</li>
  <li>The handler route exists (<code>app/api/shipcue/[...path]/route.ts</code>, or <code>--route &lt;file&gt;</code>).</li>
  <li>The env vars it reads (<code>DATABASE_URL</code>, <code>SHIPCUE_TOKEN</code>) are in <code>.env*</code> and, when the project is linked, on Vercel. Values are never printed.</li>
  <li>With <code>--url</code>: <code>/capabilities</code> answers, the agent API takes your token, and the tables exist with RLS on and every column. A missing column prints the "Upgrading from …" lines to run.</li>
</ul>
<p>On shipcue Cloud: <code>npx shipcue init --cloud pk_…</code> prints the env line and a small <code>ShipcueButton</code> component for Next.js; <code>--write</code> adds them.</p>

<h2>4. Connect an agent</h2>
<pre><code>claude mcp add shipcue \\
  -e SHIPCUE_URL=https://your.app/api/shipcue \\
  -e SHIPCUE_TOKEN=... \\
  -- npx shipcue-mcp</code></pre>
<p>The agent gets these tools: <code>file_report</code> (files a report for a person, with no token needed; the panel's Copy prompt for my agent link sets it up), <code>list_reports</code>, <code>claim_next_report</code>, <code>get_report</code>, <code>claim_report</code>, <code>release_report</code> and <code>close_report</code>. A claimed report arrives as a task prompt with the description, page, screenshots, app snapshot and what to do next: reproduce, write a failing test, fix, close with the PR link.</p>

<h2>5. Show the queue and a changelog</h2>
<p>Let people see what is waiting and what got fixed. Switch the board on in the handler, then drop the component on any page:</p>
<pre><code>createShipcueHandler({ ..., board: true })   // or (req) =&gt; isSignedIn(req)
                                             // boardScreenshots: true also shows screenshots (opt-in)

import { ShipcueBoard } from 'shipcue/react';
&lt;ShipcueBoard endpoint="/api/shipcue" /&gt;        // or &lt;ShipcueQueue /&gt;, &lt;ShipcueChangelog /&gt;</code></pre>
<p>The board lists open and in-progress reports, most urgent first, and every fixed report with the resolution it was closed with, latest first. It never shows who filed a report, the page it came from, diagnostics or attachments. Close reports with a one-line, user-facing resolution and the changelog writes itself. It updates live as reports come in, and each viewer can switch between pills and tabs, cards and a list. See it on <a href="/cuelog/">shipcue's own CueLog</a>.</p>
<h2>The CueLog table</h2>
<p>For your team: every report in full, claimed and worked by people and agents together. Give the handler a <code>team</code> option with <code>getMember</code> (who is signed in, and their role: owner, member or viewer) and <code>claimants</code> (the people and agents a report can go to), then render <code>&lt;CueLogTable endpoint="/api/shipcue" /&gt;</code> on a signed-in page. Claim a report, assign it to a teammate, or queue it for an agent: that agent's <code>claim_next_report</code> returns it first. Give each agent its own token with the <code>agents</code> option and a lease with <code>leaseSeconds</code>; an agent that stops sending <code>heartbeat_report</code> loses the report back to the queue, and <code>submit_for_review</code> moves it to In review with the PR link. Run the "Upgrading from 0.12" lines in <code>sql/schema.sql</code> first. Or use <a href="/cloud/">shipcue Cloud</a>, where all of this is hosted.</p>

<h2>6. Broadcast and listen</h2>
<p>Tell people or agents when a report is filed, claimed, released, closed or gets a video. Each broadcaster gets the events it asks for; one that fails never fails the request.</p>
<pre><code>import { slack, webhook } from 'shipcue/server';

createShipcueHandler({ ...,
  broadcasters: [
    slack({ webhookUrl: process.env.SLACK_WEBHOOK }),
    webhook({ url: 'https://mac-mini.tailnet.ts.net/shipcue', secret: process.env.HOOK_SECRET, events: ['report.filed'] }),
  ],
})</code></pre>
<p>An agent that would rather not open a port can listen instead. <code>shipcue-listen</code> polls the queue and runs a command for each event, with the event as JSON on stdin:</p>
<pre><code>SHIPCUE_URL=https://app.example.com/api/shipcue SHIPCUE_TOKEN=... \
  npx shipcue-listen --on filed -- claude -p "Fix the newest report in the shipcue queue"</code></pre>
<p>Events: <code>filed</code>, <code>assigned</code> (queued for this agent), <code>claimed</code>, <code>released</code>, <code>closed</code>, <code>video</code>. shipcue Cloud writes the launchd or systemd file that keeps it running (<a href="/cloud/">Run a listener</a>).</p>
<h3>One digest instead of a message per event</h3>
<p>Turn on <code>digest</code> and a cron gets one summary per hour or day: what was filed, fixed (with the fix line and PR), reopened, claims stuck past their lease, how many are still open and the oldest waiting. Never who filed it, the page or the app snapshot.</p>
<pre><code>import { slackDigest, emailDigest } from 'shipcue/server';

createShipcueHandler({ ..., agentToken: process.env.SHIPCUE_TOKEN,
  digest: { every: 'day', send: slackDigest({ webhookUrl: process.env.SLACK_WEBHOOK }) },
})

# Vercel Cron, GitHub Actions or launchd, once a day:
curl -X POST https://app.example.com/api/shipcue/digest -H "Authorization: Bearer $SHIPCUE_TOKEN"</code></pre>
<p>Without <code>send</code> it returns the digest as Markdown, ready for a daily note or an outliner log. Quiet periods send nothing (<code>sendEmpty</code> to send anyway); <code>digest(store, { since, until, format })</code> builds one anywhere.</p>

<h2>7. Close the loop with GitHub</h2>
<p>Let pull requests move reports. A PR whose title, body or branch names a report (its full id or first 8 characters, say <code>fix/919f5ca2-github-loop</code>) moves it to In review with the PR link; merging it marks it Fixed ("Merged in #N"); closing it unmerged puts it back in the queue. Ids that are not reports in this queue are ignored.</p>
<pre><code>createShipcueHandler({ ...,
  github: {
    secret: process.env.SHIPCUE_GITHUB_SECRET,
    // Optional: stay in review until production serves the merge commit, then "live in abc1234".
    liveCheck: { url: 'https://app.example.com/api/version' },
  },
})</code></pre>
<p>In the repository: <strong>Settings → Webhooks → Add webhook</strong>, Payload URL <code>https://your.app/api/shipcue/github</code>, content type <code>application/json</code>, the same secret, and only the <strong>Pull requests</strong> event. <code>liveCheck</code> is checked when the board, the CueLog or an agent reads the queue (at most once a minute), or call <code>handler.checkLive()</code> from a cron. On shipcue Cloud, Setup gives each project its webhook URL and secret.</p>

<h2>HTTP API</h2>
<p>Everything except filing a report needs <code>Authorization: Bearer $SHIPCUE_TOKEN</code>. Leave <code>agentToken</code> unset to switch the agent API off.</p>
<pre><code>POST /reports                 file a report (multipart form, from the button)
GET  /reports?status=open     the queue, most urgent first
GET  /reports/:id             one report plus its task prompt
POST /reports/next/claim      take the most urgent open report (204 when empty)
POST /reports/:id/claim       take a specific report (409 if someone has it)
POST /reports/:id/release     give it back to the queue
POST /reports/:id/close       { "status": "fixed" | "wontfix", "resolution": "PR link" }
POST /reports/:id/note        { "text": "..." }: a note on the report's history
POST /digest                  { since?, until?, every? }: the last period's digest (with the digest option)
GET  /board                   no token: the queue and the changelog (only with board on)
GET  /board/version           no token: changes whenever a report does (for a live board)
GET  /capabilities            no token: what the handler takes (video, files, limits) and the shipcue version it runs
POST /github                  GitHub's signed pull_request webhook (only with github on)</code></pre>

<h2>What a report holds</h2>
<ul>
  <li>Type: bug, feature request or agent task</li>
  <li>Priority: low, medium, high or blocking</li>
  <li>Area: the parts of your app you list, plus Other</li>
  <li>Description, 10 to 4,000 characters</li>
  <li>Up to 3 screenshots, 5 MB each, shrunk in the browser first</li>
  <li>Context: text picked out on the page, up to 20,000 characters</li>
  <li>Page address, browser and your app snapshot</li>
  <li>Status: open, claimed, fixed or won't fix, with who claimed it and the resolution</li>
</ul>
</div>
"""

CLOUD = """
<div class="prose">
<h1>Cloud</h1>
<p class="lede">The same queue without running a database: add the button, get a hosted queue, and work it in the CueLog with your team and your agents.</p>
<div class="note">shipcue Cloud is in an invite-only beta, free while it lasts. <a href="/app/">Sign in</a>, or <a href="/contact/">ask to join</a>.</div>
<h2>What you get</h2>
<ul>
  <li><strong>A hosted queue.</strong> One project per app, with a key for the button. No table, no handler to run.</li>
  <li><strong>The CueLog.</strong> One table with every report in full: who filed it, screenshots, context, the app snapshot. Filter, sort, set priority, and see each report's history.</li>
  <li><strong>People and agents claim from the same table.</strong> Claim a report yourself, assign it to a teammate, or queue it for an agent. Each agent has its own token, so you can see which one holds what.</li>
  <li><strong>No double work.</strong> Claims are all-or-nothing. An agent's claim runs out if it stops checking in, and an open PR puts the report in review.</li>
  <li><strong>A team.</strong> Invite people as owners, members (work the queue) or viewers (see it).</li>
  <li><strong>Notes.</strong> People and agents leave notes on a report (the <code>add_note</code> MCP tool); the CueLog shows them in its history.</li>
</ul>
<h2>Set up</h2>
<ol>
  <li><a href="/app/">Sign in</a> and create a project.</li>
  <li>Add <code>&lt;ReportButton endpoint="…/api/cloud/p/&lt;key&gt;" reporter={user?.email} /&gt;</code> to your app (or run <code>npx shipcue init --cloud &lt;key&gt; --write</code> in a Next.js app), and list the sites it runs on. <code>reporter</code> is who is signed in on your site, so the CueLog shows who filed each report. shipcue cannot check it, so Cloud projects have no reporter portal (a "My reports" list on any device); the Yours list stays per browser.</li>
  <li>Connect an agent: Setup gives you the <code>claude mcp add shipcue …</code> line with that agent's token.</li>
  <li>Optional: under <strong>Close the loop with GitHub</strong>, turn on the project's webhook and add its URL and secret to your repository (Pull requests only), so opening a PR puts a report in review and merging it marks it Fixed.</li>
</ol>
<h2>Run a listener</h2>
<p>Keep an agent working the queue on your own machine, like a daemon. In Setup, under <strong>Run a listener</strong>, pick an agent (or create one on the spot, and its token is filled in), choose the events (filed, assigned to it, claimed, released, closed, video) and what it runs for each one. By default that is:</p>
<pre><code>claude -p "Use the shipcue MCP tools to claim the report in $SHIPCUE_REPORT_ID, fix it, open a PR and submit it for review"</code></pre>
<p>Copy it as one command, as a macOS launchd agent (it keeps running, starts at login and logs to <code>~/Library/Logs/shipcue-listen-&lt;project&gt;.log</code>) or as a Linux systemd <code>--user</code> unit. The listener checks the queue every 15 seconds and needs no open port. For instant delivery, point the project's webhook (Forward reports) at that machine instead, say a Tailscale Funnel address.</p>
<h2>Hosted agent</h2>
<p>Every project can turn on <strong>shipcue-agent</strong>, an agent that runs on shipcue, so there is nothing to install. Assign a report to it in the CueLog (or switch on <em>Triage every new report</em>) and it reads the report with OpenAI and leaves a note: a one-paragraph summary, the likely area, a suggested priority with a reason, steps to reproduce or what is missing, and a short plan for a coding agent. Then it puts the report back in the queue for a person or a coding agent to fix. It never changes code, never sees screenshots or who filed the report, and treats the report's words as data, not instructions. Each project gets a daily allowance of triages.</p>
<p>Its note comes with one-click suggestions: <strong>Apply priority</strong>, <strong>Apply area</strong> and, when it spots that the report repeats one of the project's open reports (it reads their headlines in the same call, nothing else about them), <strong>Merge into #id</strong>. Merge closes the duplicate as won't fix with a link to the original, notes both and counts the extra reporters on the original. Nothing changes until someone clicks, and each click is in the report's history under their name.</p>
<h2>All projects</h2>
<p>On two or more projects, Cloud opens on <strong>All projects</strong>: one row per project you are on, with what is open, claimed and in review, how long the oldest open report has been waiting, agent claims stuck past their lease, and how many open reports nobody has looked at yet (never claimed, assigned or noted). <strong>Nobody has looked</strong> lists those reports, oldest first, each opening in its project's CueLog. Add your app's shipcue endpoint in Setup → Settings and the row shows the version it runs (from its <code>/capabilities</code>), flagged when it is behind; an app that does not answer quickly shows "unknown". The CueLog's "Claimed by" filter has the same <em>Nobody has looked</em>.</p>
<h2>Digest</h2>
<p>Rather have one message than one per event? Under <strong>Digest</strong>, pick hourly or daily and send it to the project's Slack channel or the owner's email: what was filed, fixed (with the fix line and PR), reopened, claims stuck past their lease, how many are still open and the oldest waiting. Quiet periods send nothing, and it never includes who filed a report or the app snapshot.</p>
<h2>What stays the same</h2>
<p>The button, the API and the MCP tools are the same as the open source package, and the CueLog table is in it too (<code>CueLogTable</code> with the handler's <code>team</code> option). You can move between hosted and self-hosted at any time.</p>
<h2>Later</h2>
<ul>
  <li>Sending reports on to GitHub Issues and Linear</li>
  <li>A hosted agent that opens the PR too</li>
</ul>
</div>
"""

USE_CASES = """
<div class="prose">
<h1>Use cases</h1>
<p class="lede">shipcue is for any team where the people who find problems and the agents that fix them are not the same, and you want one queue between them instead of a group chat.</p>

<h2>Hackathon teams running many agents</h2>
<p>At a hackathon everyone is building at once, and now each person has two or three coding agents going as well. The hard part stops being writing code and becomes coordination: two agents fixing the same bug, one agent's change undoing another's, a teammate asking in the chat "is anyone on the login bug?" and nobody being sure.</p>
<p>With shipcue the whole team files bugs and feature ideas through the button in the app you are building. Every agent pulls from the same queue, and a claim is atomic, so once an agent has a report nobody else can take it. When it is done it closes the report with the PR link, so the team can see what shipped without asking.</p>
<p><b>Set up:</b> create the table in the Supabase, InsForge or Neon database you already have for the project, mount the handler, add the button, and run <code>claude mcp add shipcue</code> on each teammate's machine with the same URL and token. It takes about ten minutes, so it is worth doing in the first hour.</p>
<p><b>Tip:</b> give each teammate's agent its own name with <code>SHIPCUE_AGENT</code> (for example <code>claude@maya</code>), so the queue shows whose agent is on what.</p>

<h2>Founders with early users</h2>
<p>Early users will tell you what is broken, but usually in a DM, in a call, or in a screenshot with no context. The button lets them report from the page where it happened, and shipcue attaches the page address, the browser and a snapshot of app state you choose, so the report is already close to a task an agent can act on.</p>
<p>Point Claude Code or Codex at the queue and let it work through the most urgent reports first. Each one arrives as a task prompt: reproduce it, write a failing test, fix it, close it with the PR. You stay the reviewer, not the person retyping bug reports into prompts.</p>

<h2>Internal tools and dashboards</h2>
<p>Internal tools collect small annoyances that nobody files because filing is a hassle. Put the inline button in the header, require sign-in with <code>getReporter</code> so every report has a name on it, and use <code>onReport</code> to post new reports to Slack or email the team. Reports stay in your own database, which matters when the tool touches member or customer data.</p>

<h2>Beta tests and dogfooding sessions</h2>
<p>Get the team or a group of testers to click through the app for thirty minutes and report everything they hit. Areas (the parts of your app you list) and priority keep the pile sorted, so when the session ends the queue is already in order: blocking bugs first, then high, then the rest by age. Agents can start on the top of the list while you are still reading the bottom.</p>

<h2>Feature requests, not just bugs</h2>
<p>The same button takes feature requests. An agent can claim one and draft it as a PR, or you can close it as won't fix with a short reason in the resolution, so the person who asked is not left wondering.</p>

<h2>Several kinds of agents on one codebase</h2>
<p>shipcue does not care which agent claims a report. Claude Code, Codex and a teammate working by hand can all pull from the same queue over MCP or the HTTP API. If an agent gets stuck, it releases the report and it goes back to the queue for someone else.</p>

<h2>When it is not the right fit</h2>
<ul>
  <li>You want a public roadmap with voting today. shipcue is an inbox for your team; an optional voting board is on the roadmap.</li>
  <li>Your team already lives in Linear or GitHub Issues and is happy there. Forwarding reports to them is planned for <a href="/cloud/">Cloud</a>; for now you can do it yourself in <code>onReport</code>.</li>
  <li>You do not have a Postgres database and do not want one. Cloud is meant for that, and it is not built yet.</li>
</ul>
<p><a class="btn btn-ink" href="/docs/">Set it up</a></p>
</div>
"""

BLOG = """
<div class="prose">
<h1>Blog</h1>
<ul class="post-list">
  <li><a href="/blog/hackathon-teams-and-agents/">Coordinating a hackathon team when everyone has agents</a><div class="meta">October 1, 2026 · Chinat Yu</div></li>
  <li><a href="/blog/fixqueue-is-now-shipcue/">fixqueue is now shipcue, and it is open source</a><div class="meta">October 1, 2026 · Chinat Yu</div></li>
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

<p>So shipcue treats the inbox as a queue. Reports sit in your own Postgres, most urgent first. An agent connects over MCP, claims the top report, gets it as a task (reproduce it, write a failing test, fix it), and closes it with the PR link. The claim is atomic, so you can point several agents at the queue and none of them will ever pick up the same report.</p>

<h2>Why self-hosted</h2>
<p>There are good hosted feedback tools already. I wanted something that lives in the database I already have, that I can read with SQL, and that does not need another login for the team. It is one table, one handler and one React component.</p>

<h2>What is next</h2>
<p>The first version is built and tested, and the code is now public on <a href="https://github.com/cyu60/shipcue">GitHub</a> under the MIT license. Next I am moving my own apps onto it, starting with the outliner. If you try it, or you have a queue of reports you wish an agent would just handle, <a href="/contact/">get in touch</a>. I would really love to hear how you end up using it.</p>
</article>
"""

HACKATHON_POST = """
<article class="prose">
<h1>Coordinating a hackathon team when everyone has agents</h1>
<p class="meta">October 1, 2026 · Chinat Yu</p>

<p>I have been around a lot of hackathons through MentorMates, and I think that one of the things that separates the teams that do well from the ones that do not is honestly not the idea, or even how fast they code, but how well they coordinate with each other on the product. Who is building what, what is broken, what matters most before the demo.</p>

<p>That was already hard with four people and a group chat. Now that everyone is also running coding agents, I think it has become a lot harder. Each person has two or three agents going, and the agents do not talk to each other. It is really easy to end up with two agents fixing the same bug in slightly different ways, or one agent undoing what another one just shipped, and then you spend the last hour before judging working out which version is the real one.</p>

<p>The fix I kept coming back to was basically a queue. Everyone on the team reports bugs and ideas through a small button at the bottom of the app they are building, and that goes into one list, sorted by how urgent it is. Agents pull from that list instead of from whatever someone pasted into a terminal. When an agent takes a report it is claimed, so no other agent can take it, and when it is done it closes it with the PR link, so the whole team can see what is fixed without asking.</p>

<p>I built this for my own projects, first as a one-off and then again and again, and I have now made it open source as <a href="/">shipcue</a>. It is one table in the Postgres you already have, one handler and one React button, plus an MCP server so Claude Code and Codex can work the queue. It takes about ten minutes to set up, which I think is worth it in the first hour of a hackathon.</p>

<p>A few things I would suggest if you try it at your next hackathon:</p>
<ul>
  <li>Set it up before anyone starts building features, so the habit is "report it in the app" and not "mention it in the chat".</li>
  <li>Give each teammate's agent its own name with <code>SHIPCUE_AGENT</code>, so you can see whose agent is on what.</li>
  <li>Mark the things that would break your demo as blocking. They go to the top of the queue, and those are the ones you really want fixed first.</li>
  <li>Let mentors and friends who try your app report into it as well too. That is pretty much free testing.</li>
</ul>

<p>If you are building at a hackathon this season, I would love for you to add it on day one and tell me what breaks. The code is on <a href="https://github.com/cyu60/shipcue">GitHub</a> and the setup is in the <a href="/docs/">docs</a>.</p>
</article>
"""

RENAME_POST = """
<article class="prose">
<h1>fixqueue is now shipcue, and it is open source</h1>
<p class="meta">October 1, 2026 · Chinat Yu</p>

<p>For the first day of its life this project was called fixqueue, which was a pretty good working name, because it was basically a queue of fixes. But the more I used it, the more I realised that a lot of what goes into the queue is not fixes at all. It is feature requests, small ideas, things people wish the app did, and I wanted a name that covered all of that and was a bit more fun to say as well too.</p>

<p>So it is now shipcue. Said out loud it sounds like "ship queue", which is what it is, and a cue is also the signal for someone to go, which is what the button does. Someone reports something, that cues an agent, and the agent ships it.</p>

<p>I also made the repository public, since the whole point is for other teams to use it. It is MIT licensed and lives at <a href="https://github.com/cyu60/shipcue">github.com/cyu60/shipcue</a>.</p>

<h2>What changed</h2>
<p>If you set it up early under the old name, these are the things to rename:</p>
<ul>
  <li>The package is <code>shipcue</code>, with <code>shipcue/server</code> and <code>shipcue/react</code></li>
  <li>The MCP server is <code>npx shipcue-mcp</code></li>
  <li>The environment variables are <code>SHIPCUE_URL</code>, <code>SHIPCUE_TOKEN</code> and <code>SHIPCUE_AGENT</code></li>
  <li>The handler is <code>createShipcueHandler</code> and its default path is <code>/api/shipcue</code></li>
  <li>The default table is <code>shipcue_reports</code>. If you already have a <code>fixqueue_reports</code> table you can keep it with <code>postgresStore(db, 'fixqueue_reports')</code>, or rename it with <code>ALTER TABLE fixqueue_reports RENAME TO shipcue_reports</code></li>
</ul>
<p>Old links to the GitHub repository and to fixqueue.vercel.app redirect to the new ones, so nothing you shared before should break.</p>

<p>If you have ideas for it, or you try it and something does not work, <a href="/contact/">let me know</a>.</p>
</article>
"""

CONTACT = """
<div class="prose">
<h1>Contact</h1>
<p class="lede">The way to reach us is shipcue itself. Questions, ideas, early access or something that broke: send it here and it lands in the same queue we work from.</p>
<div class="actions">
  <button class="btn btn-ink" type="button" onclick="window.shipcue && window.shipcue.openReport('feature')">Ask a question or request a feature</button>
  <button class="btn btn-plain" type="button" onclick="window.shipcue && window.shipcue.openReport('bug')">Report a bug</button>
</div>
<p>You can also press the ship button at the bottom right of any page, or <code>⌃F</code> / <code>⌃B</code> on a Mac (<code>Alt+Shift+F</code> / <code>Alt+Shift+B</code> elsewhere).</p>
<h2>Good things to include</h2>
<ul>
  <li>What your app is built with: framework, database, auth</li>
  <li>Where your bug reports go today</li>
  <li>Whether you want to self-host or would rather use the hosted Cloud</li>
  <li>How to reach you back, if you are not signed in anywhere we can see</li>
</ul>
</div>
"""

page("index.html", "shipcue: bug reports your coding agents can fix", "A report button, a queue in your own Postgres, and an MCP server so coding agents can fix what people report.", HOME, "/")
DOCS = DOCS.replace("{VERSION}", VERSION)
page("docs/index.html", "Docs · shipcue", "Set up shipcue: the table, the handler, the button and the agent tools.", DOCS, "/docs/")
page("cloud/index.html", "Cloud · shipcue", "shipcue Cloud: a hosted queue and the CueLog, where your team and your agents claim reports together.", CLOUD, "/cloud/")
APP = """<div id="shipcue-app"></div>
<script src="/assets/shipcue-app.js" defer></script>
"""
page("app/index.html", "CueLog · shipcue Cloud", "Sign in to shipcue Cloud and work your CueLog.", APP, "/cloud/")
MINE = """<div class="prose">
<h1>My reports</h1>
<p class="lede">What you sent to shipcue while signed in, where each one stands, and how it was fixed. The same on any device.</p>
</div>
<div id="shipcue-mine"></div>
<script src="/assets/shipcue-mine.js" defer></script>
"""
page("app/mine/index.html", "My reports · shipcue", "The reports you sent to shipcue, and how each was fixed.", MINE, "/cloud/")
page("blog/index.html", "Blog · shipcue", "Notes on building shipcue.", BLOG, "/blog/")
page("blog/agents-should-read-your-bug-reports/index.html", "Your bug report button should feed your agents · shipcue", "Why shipcue treats the bug report inbox as a queue that agents work from.", POST, "/blog/")
page("use-cases/index.html", "Use cases · shipcue", "Who shipcue is for: hackathon teams running many agents, founders with early users, internal tools, beta tests and more.", USE_CASES, "/use-cases/")
page("blog/hackathon-teams-and-agents/index.html", "Coordinating a hackathon team when everyone has agents · shipcue", "Why a shared queue keeps a hackathon team's coding agents from colliding.", HACKATHON_POST, "/blog/")
page("blog/fixqueue-is-now-shipcue/index.html", "fixqueue is now shipcue, and it is open source · shipcue", "The new name, the public repository, and what to rename if you set it up early.", RENAME_POST, "/blog/")
CHANGELOG = """<div class="prose">
<h1>CueLog</h1>
<p class="lede">Everything people have asked shipcue for, straight from its own CueLog: what is waiting, and what got fixed and how. Send something with the ship button and it shows up here.</p>
</div>
<div id="shipcue-board" class="board"></div>
<script src="/assets/shipcue-board.js" defer></script>
"""

page("cuelog/index.html", "CueLog · shipcue", "What people asked shipcue for, what is waiting, and what got fixed.", CHANGELOG, "/cuelog/")
EXTENSION = """<div class="prose">
<h1>Chrome extension</h1>
<p class="lede">Report what you see on any page, even sites you do not run. The shipcue extension sends your words with a screenshot of the tab, the element you click on, and when and where it happened, straight into a shipcue queue.</p>
<p><a class="btn btn-ink" href="/assets/shipcue-extension.zip" download>Download for Chrome (.zip, version {EXT_VERSION})</a></p>

<h2>Install it</h2>
<ol>
  <li>Download the zip above and unzip it. You get a <code>shipcue-extension</code> folder.</li>
  <li>Open <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).</li>
  <li>Click <b>Load unpacked</b> and choose the <code>shipcue-extension</code> folder.</li>
  <li>Pin it from the puzzle-piece menu. Open it with the icon, or with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.</li>
</ol>
<p>It works the same in Edge, Brave, Arc and other Chromium browsers.</p>

<h2>What comes along</h2>
<ul>
  <li><b>A screenshot</b> of the tab you are looking at (untick it to leave it out).</li>
  <li><b>The element you pick</b>: click <i>Pick an element</i>, then anything on the page. Its selector, text, size, position and HTML go into the report's Context.</li>
  <li><b>Text you selected</b> on the page.</li>
  <li><b>Page details</b>: the address, title, time and time zone, window size, scroll position and language.</li>
  <li><b>Your location</b>, only if you tick <i>My location</i> (Chrome asks first).</li>
</ul>
<p>Nothing is read or sent until you open the extension, and nothing leaves until you press Send.</p>

<h2>Send to your own app</h2>
<p>It sends to shipcue's own CueLog until you change it. Open the extension, click ⚙ and paste your app's shipcue address, the one <code>createShipcueHandler</code> is mounted at (for example <code>https://app.example.com/api/shipcue</code>). Chrome asks once for permission to send there. Add your CueLog page too, and the extension links to it after each report.</p>
</div>
"""

EXTENSION = EXTENSION.replace("{EXT_VERSION}", EXT_VERSION)
page("extension/index.html", "Chrome extension · shipcue", "Report what you see on any page: a screenshot, the element you pick, and when and where, straight into a shipcue queue.", EXTENSION, "/extension/")
page("contact/index.html", "Contact · shipcue", "Get in touch about shipcue.", CONTACT, "/contact/")
print("built")
