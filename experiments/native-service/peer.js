import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
const directory = process.argv[2];
let active = 0;
createServer(async (req, res) => {
  const behavior = readFileSync(path.join(directory, "behavior.txt"), "utf8");
  const name = req.url.slice(1);
  const cookie = req.headers.cookie || "";
  active++;
  res.on("close", () => active--);
  appendFileSync(
    path.join(directory, "requests.jsonl"),
    JSON.stringify({
      name,
      cookie,
      userAgent: req.headers["user-agent"],
      at: Date.now(),
      active,
    }) + "\n",
  );
  if (behavior === "stall" || (behavior === "stall-probe" && name === "probe"))
    return;
  if (behavior === "http-error") {
    res.writeHead(503).end();
    return;
  }
  if (behavior === "oversized") {
    res.writeHead(200, { "Content-Length": 9 * 1024 * 1024 }).end();
    return;
  }
  if (behavior === "oversized-chunked") {
    res.writeHead(200);
    for (let i = 0; i < 144 && !res.destroyed; i++) {
      res.write(Buffer.alloc(65536, 120));
      await delay(1);
    }
    res.end();
    return;
  }
  if (name !== "manifest.json" && cookie !== "fixture=accepted") {
    res.writeHead(403).end();
    return;
  }
  if (!/Safari/.test(req.headers["user-agent"])) {
    res.writeHead(400).end();
    return;
  }
  if (name === "manifest.json")
    res.setHeader("Set-Cookie", "fixture=accepted; Path=/; HttpOnly");
  if (name === "probe") {
    await delay(80);
    res.end(behavior === "bad-body" ? "wrong" : "native-fixture-ok\n");
    return;
  }
  if (!/^[a-z-]+\.(json|html)$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.end(readFileSync(path.join(directory, "fixtures", name)));
  } catch {
    res.writeHead(404).end();
  }
}).listen(8080, "0.0.0.0");
