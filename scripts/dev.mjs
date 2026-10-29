import http from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../api/agent.mjs';
import authHandler from '../api/auth.mjs';
import observatoryHandler from '../api/observatory.mjs';
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
http.createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (req.url.startsWith('/api/agent')) return handler(req, res);
  if (req.url.startsWith('/api/observatory')) return observatoryHandler(req,res);
  if (req.url.startsWith('/api/auth')) return authHandler(req, res);
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); return res.end(); }
  try { res.setHeader('Content-Type', file[1]); res.end(await readFile(new URL(`../public/${file[0]}`, import.meta.url))); }
  catch { res.writeHead(500); res.end('Arquivo indisponível'); }
}).listen(3000, '127.0.0.1', () => console.log('Trade Lab: http://localhost:3000'));
