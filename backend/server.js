import http from "node:http";
import { searchFar, getMeta } from "./search.js";

const PORT = Number(process.env.PORT || 8787);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": FRONTEND_ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "clausefinder-backend" });
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      return sendJson(res, 200, await getMeta());
    }
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readJson(req);
      return sendJson(res, 200, await searchFar(body));
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: "ClauseFinder backend error",
      detail: process.env.NODE_ENV === "production" ? undefined : String(error?.stack || error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`ClauseFinder backend listening on ${PORT}`);
});
