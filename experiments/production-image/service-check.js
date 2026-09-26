import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// The service and all synthetic upstreams share host loopback on Linux.
export async function checkService(image, common) {
  const messages = [];
  const requests = [];
  const offsets = [];
  let updatesDelivered = false;
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url.startsWith("/ru/category/")) {
      const id = request.url.includes("/1377/") ? "200" : "100";
      response.setHeader("content-type", "text/html");
      response.end(
        `<div id="contentr"><a class="category-data-list-card__destination" href="/ru/item/${id}"><div class="pt">Квартира</div><div class="p">200000 ֏</div><div class="l">Кентрон</div><div class="at">2 ком. · 60 кв.м. · 2/5</div><div class="d">Сегодня, 00:00</div></a></div>`,
      );
      return;
    }
    if (request.url === "/cba") {
      response.setHeader("content-type", "text/xml");
      response.end(
        `<ExchangeRatesLatestResult><CurrentDate>${new Date().toISOString().slice(0, 10)}</CurrentDate>${["USD", "EUR", "RUB"].map((iso) => `<ExchangeRate><ISO>${iso}</ISO><Amount>1</Amount><Rate>400</Rate></ExchangeRate>`).join("")}</ExchangeRatesLatestResult>`,
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    const method = request.url.split("/").at(-1);
    let result = true;
    if (method === "getMe") result = { id: 99, is_bot: true };
    if (method === "getUpdates") {
      offsets.push(payload.offset ?? 0);
      await delay(50);
      result = updatesDelivered
        ? []
        : [
            {
              update_id: 1,
              message: {
                chat: { id: 123, type: "private" },
                from: { id: 123 },
                text: "/start",
              },
            },
            {
              update_id: 2,
              callback_query: {
                id: "initial",
                from: { id: 123 },
                message: { message_id: 9, chat: { id: 123, type: "private" } },
                data: "m:start:initial",
              },
            },
          ];
      updatesDelivered = true;
    }
    if (["sendMessage", "editMessageText"].includes(method)) {
      messages.push(payload);
      result = { message_id: 1000 + messages.length };
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  // Remove automatic deletion so clean signal exits can be inspected.
  const options = common.filter((arg) => arg !== "--rm");
  options[options.indexOf("--network") + 1] = "host";
  const env = [
    `HEALTH_PORT=${port}`,
    "INITIAL_PAGE_COUNT=1",
    "POLL_INTERVAL_MS=100",
    "TELEGRAM_POLL_TIMEOUT_SECONDS=1",
    "EXTERNAL_RETRY_BASE_MS=10",
    "CURL_IMPERSONATE_PATH=/usr/local/bin/curl-impersonate",
  ].flatMap((value) => ["-e", value]);
  const containers = [];
  const logs = [];
  function start() {
    const id = execFileSync(
      "docker",
      [
        ...options,
        "--detach",
        ...env,
        image,
        "serve",
        "--telegram-endpoint",
        `${origin}/telegram`,
        "--source-origin",
        origin,
        "--cba-endpoint",
        `${origin}/cba`,
      ],
      { encoding: "utf8" },
    ).trim();
    containers.push(id);
    return id;
  }
  async function ready(id) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert.equal(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", id],
          { encoding: "utf8" },
        ).trim(),
        "true",
        execFileSync("docker", ["logs", id], { encoding: "utf8" }),
      );
      try {
        if ((await fetch(`http://127.0.0.1:${port}/ready`)).status === 200)
          return;
      } catch {
        /* Listener starts after state validation. */
      }
      await delay(100);
    }
    assert.fail("Packaged service did not become ready");
  }
  function stop(id) {
    execFileSync("docker", ["stop", "--time", "15", id]);
    logs.push(execFileSync("docker", ["logs", id], { encoding: "utf8" }));
    assert.equal(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.ExitCode}}", id],
        { encoding: "utf8" },
      ).trim(),
      "0",
    );
  }
  try {
    const first = start();
    await ready(first);
    const deadline = Date.now() + 20000;
    while (
      !messages.some((message) => message.text?.includes("/ru/item/100")) &&
      Date.now() < deadline
    )
      await delay(50);
    assert(
      messages.some((message) => message.text?.includes("/ru/item/100")),
      "Packaged service must deliver an apartment through the local Telegram peer",
    );
    assert(!messages.some((message) => message.text?.includes("/ru/item/200")));
    assert(requests.some((url) => url.includes("/1377/")));
    assert(requests.includes("/cba"));
    assert.equal(
      JSON.parse(
        execFileSync(
          "docker",
          [
            "exec",
            first,
            "/usr/local/bin/rental-app",
            "health-check",
            "--ready",
            "--json",
          ],
          { encoding: "utf8" },
        ),
      ).status,
      "ready",
    );
    stop(first);
    const count = messages.filter((message) =>
      message.text?.includes("/ru/item/100"),
    ).length;
    const priorRequests = requests.length;
    const priorOffsets = offsets.length;
    const second = start();
    await ready(second);
    const restartDeadline = Date.now() + 10000;
    while (
      !requests.slice(priorRequests).some((url) => url.includes("/1377/")) &&
      Date.now() < restartDeadline
    )
      await delay(100);
    assert(requests.slice(priorRequests).some((url) => url.includes("/1377/")));
    await delay(1500);
    stop(second);
    assert(offsets.slice(priorOffsets).length > 0);
    assert(
      offsets.slice(priorOffsets).every((offset) => offset === 3),
      "Restart must preserve Telegram update offset",
    );
    assert.equal(
      messages.filter((message) => message.text?.includes("/ru/item/100"))
        .length,
      count,
      "Restart must preserve acknowledged delivery",
    );
    return {
      checks: [
        "packaged-service-readiness",
        "local-source-and-fx",
        "telegram-delivery",
        "graceful-stop",
        "restart-no-duplicate-delivery",
      ],
      logs,
    };
  } finally {
    for (const id of containers)
      execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
