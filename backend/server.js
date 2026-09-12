import http from "node:http";
import { searchFar, getMeta, getCoverage } from "./search.js";
import { loadEnvFile } from "./env.js";
import { clarifyQuestion } from "./openai.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
loadEnvFile();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": FRONTEND_ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
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
    if (req.method === "GET" && url.pathname === "/api/coverage") {
      return sendJson(res, 200, await getCoverage());
    }
    if (req.method === "POST" && url.pathname === "/api/clarify") {
      const body = await readJson(req);
      return sendJson(res, 200, await clarifyQuestion(body));
    }
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readJson(req);
      return sendJson(res, 200, await searchFar(body));
    }
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("ClauseFinder request failed", error);
    return sendJson(res, error.statusCode || 500, {
      error: error.statusCode === 413
        ? "Request body is too large"
        : error.statusCode === 400
          ? "Request body must be valid JSON"
          : "ClauseFinder backend error"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ClauseFinder backend listening on ${HOST}:${PORT}`);
});
