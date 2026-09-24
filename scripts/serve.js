// Tiny zero-dependency static server for local testing of m3-map. Usage: npm run dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/util.js';

const DIR = path.join(ROOT, 'm3-map');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.geojson': 'application/geo+json', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (file !== DIR && !file.startsWith(DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(buf);
  });
}).listen(PORT, () => console.log(`[turfscope] map → http://localhost:${PORT} (open on your phone via your LAN IP)`));
