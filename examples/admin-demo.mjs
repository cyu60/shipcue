// The admin in one route, reading your app's user: http://localhost:4546/admin
//   pnpm build && node examples/admin-demo.mjs
// Postgres is PGlite in this process. getUser stands in for your app's session: here everyone is
// dev@example.com, or whoever the x-demo-user header names.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createAdminHandler } from '../dist/admin/index.js';

const db = new PGlite();
for (const f of ['schema.sql', 'cloud.sql']) await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));

const admin = createAdminHandler({
  db,
  base: '/admin',
  page: true,
  getUser: (req) => ({ id: req.headers.get('x-demo-user') ?? 'dev', email: req.headers.get('x-demo-user') ?? 'dev@example.com' }),
  // Who may make projects; everyone else joins by invite.
  beta: ['dev@example.com'],
});

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const response = await admin(
    new Request(`http://localhost:4546${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      duplex: 'half',
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(4546, () => console.log('shipcue admin on http://localhost:4546/admin'));
