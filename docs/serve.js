// Tiny static server for local preview (avoids file:// canvas tainting).
// Run: `node serve.js` then open http://localhost:8080

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const port = process.env.PORT ? Number(process.env.PORT) : 8080;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = path.join(root, rel);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.setHeader("Content-Type", mime[path.extname(filePath)] || "application/octet-stream");
      fs.createReadStream(filePath).pipe(res);
    });
  })
  .listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Serving ${root}`);
    // eslint-disable-next-line no-console
    console.log(`Open http://localhost:${port}`);
  });

