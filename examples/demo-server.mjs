// Runs the fixqueue API on http://localhost:4545/api/fixqueue with an in-memory store.
//   pnpm build && FIXQUEUE_TOKEN=dev node examples/demo-server.mjs
import { createServer } from 'node:http';
import { createFixqueueHandler, memoryStore } from '../dist/server/index.js';

const handler = createFixqueueHandler({
  store: memoryStore(),
  config: { areas: [{ value: 'editor', label: 'Editor' }, { value: 'other', label: 'Other' }], minLength: 10, maxLength: 4000, maxScreenshots: 3, maxScreenshotBytes: 5 * 1024 * 1024 },
  agentToken: process.env.FIXQUEUE_TOKEN ?? 'dev',
  onReport: async (r) => console.log(`new ${r.type} [${r.priority}]: ${r.description.split('\n')[0]}`),
});

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:4545${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
    duplex: 'half',
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(4545, () => console.log('fixqueue demo on http://localhost:4545/api/fixqueue'));
