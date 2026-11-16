import { test, expect } from "@playwright/test";
test("graph canvas, inspector and provider evidence", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Build a verified artifact" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.getByRole("button", { name: "Inspect work", exact: true }).click();
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByRole("button", { name: /^Inspect [0-9a-f]{12}$/ }).click();
  await expect(page.getByText("검증 결과", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "노드 상세 닫기" }).click();
  await page.getByRole("button", { name: "사용량·한도" }).click();
  await page.getByRole("button", { name: "모델별 사용 내역 보기" }).click();
  await expect(
    page.getByRole("heading", { name: "사용 내역", exact: true }),
  ).toBeVisible();
  await expect(page.locator("table").first()).toContainText("mock-1");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/providers.png", fullPage: true });
  await page.getByRole("button", { name: "작업 화면으로" }).click();
  await page.screenshot({ path: "test-results/graph.png", fullPage: true });
});

test("32 nodes, eight revisions and event resynchronization preserve selection", async ({
  page,
}) => {
  let snapshots = 0;
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.__ralphStream = this;
      }
    };
  });
  const runs = await (await page.request.get("/api/v2/runs")).json();
  const runId = runs.runs[0].runId;
  const snapshot = await (
    await page.request.get(`/api/v2/runs/${runId}`)
  ).json();
  const graph = await (
    await page.request.get(`/api/v2/runs/${runId}/graph`)
  ).json();
  await page.route("**/api/v2/runs**", async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === "/api/v2/runs") body = structuredClone(runs);
    else if (url.pathname.endsWith("/graph")) body = structuredClone(graph);
    else if (url.pathname === `/api/v2/runs/${runId}`)
      body = structuredClone(snapshot);
    else return route.continue();
    if (body.runs) body.runs = body.runs.map((r) => ({ ...r, revision: 8 }));
    else if (url.pathname.endsWith("/graph")) {
      body.revision = Number(url.searchParams.get("revision") ?? 8);
      const worker = body.nodes[0];
      body.nodes = [
        ...body.nodes,
        ...Array.from({ length: 28 }, (_, i) => ({
          ...worker,
          nodeId: `bulk-${i}`,
          generation: 0,
        })),
      ];
      body.edges.push(
        ...Array.from({ length: 28 }, (_, i) => ({
          from: `bulk-${i}`,
          to: "integrate",
          kind: "artifact",
        })),
      );
    } else if (body.nodes) {
      snapshots++;
      body.revision = 8;
    }
    return route.fulfill({ json: body });
  });
  // Keep the actual SSE endpoint unbuffered by the response transformer above.
  await page.route("**/events?*", (route) => route.continue());
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(32);
  await page.getByRole("button", { name: "Inspect work", exact: true }).click();
  const firstNode = page.locator(".react-flow__node").first();
  const before = await firstNode.evaluate((element) => element.style.transform);
  await page.evaluate(() => {
    const stream = window.__ralphStream;
    stream.dispatchEvent(
      new MessageEvent("ralph", { data: JSON.stringify({ seq: 0 }) }),
    );
    stream.dispatchEvent(
      new MessageEvent("ralph", { data: JSON.stringify({ seq: 999999 }) }),
    );
    stream.close();
    stream.dispatchEvent(new Event("error"));
  });
  await expect.poll(() => snapshots).toBeGreaterThan(1);
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(firstNode).toBeVisible();
  expect(await firstNode.evaluate((element) => element.style.transform)).toBe(
    before,
  );
  await page.getByRole("button", { name: "노드 상세 닫기" }).click();
  await page.getByRole("button", { name: "실행 메뉴" }).click();
  await page.getByLabel("그래프 이력").selectOption("1");
  await expect(page.locator(".react-flow__node")).toHaveCount(32);
  await expect(
    page.getByRole("button", { name: "다시 실행", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("그래프 이력").selectOption("8");
  await expect(page.locator(".react-flow__node")).toHaveCount(32);
  expect(
    await page
      .locator("body")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(14);
});
test("small screens retain readable controls and a dismissible inspector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 850 });
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.locator(".react-flow__node").first().click();
  await expect(
    page.getByRole("button", { name: "노드 상세 닫기" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "노드 상세 닫기" }).click();
  await expect(page.locator(".inspector")).toHaveCount(0);
});

test("keyboard navigation, historical revision and bounded large diff rendering", async ({
  page,
}) => {
  await page.route("**/artifacts/*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        verifier: { ok: true },
        diff: Array.from({ length: 100000 }, (_, i) => `+line ${i + 1}`).join(
          "\n",
        ),
      }),
    }),
  );
  await page.goto("/");
  const node = page.getByRole("button", { name: "Inspect work", exact: true });
  await node.focus();
  await node.press("Enter");
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByRole("button", { name: /^Inspect [0-9a-f]{12}$/ }).click();
  await page.getByText("파일 변경 내용", { exact: true }).click();
  const log = page.getByRole("region", { name: "파일 변경 기록" });
  await expect(log).toContainText("+line 1");
  expect(await log.locator("[data-log-line]").count()).toBeLessThan(40);
  await log.focus();
  await page.keyboard.press("End");
  await expect(log.locator('[data-log-line="100000"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector")).toHaveCount(0);
  await page.getByRole("button", { name: "실행 메뉴" }).click();
  await page.getByLabel("그래프 이력").selectOption("1");
  await expect(
    page.getByRole("button", { name: "다시 실행", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
});

test("submits worker direction and shows the revised graph from the event stream", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        window.directionStream = this;
      }
      close() {}
    };
  });
  const { runs } = await (await page.request.get("/api/v2/runs")).json();
  const runId = runs[0].runId;
  const path = `/api/v2/runs/${runId}`;
  const snapshot = await (await page.request.get(path)).json();
  const graph = await (await page.request.get(`${path}/graph`)).json();
  await page.route(`**${path}`, (route) =>
    route.fulfill({ json: { ...snapshot, status: "running" } }),
  );
  let request;
  await page.route(`**${path}/commands`, async (route) => {
    request = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      json: { accepted: true, commandId: request.commandId },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Inspect work", exact: true }).click();
  await page.getByRole("button", { name: "방향 변경" }).click();
  await page.getByLabel("방향 변경").fill("Use the revised label");
  await page.getByRole("button", { name: "변경 적용" }).click();
  await expect(page.getByRole("status")).toContainText(
    "관련 작업이 안전하게 멈출 수 있는 지점",
  );
  expect(request).toMatchObject({
    type: "steer",
    nodeId: "work",
    expectedRevision: 1,
    instruction: "Use the revised label",
  });
  await page.evaluate(
    ({ graph, seq, commandId }) => {
      const rerun = ["work", "integrate", "validate"];
      graph.revision = 2;
      graph.nodes.find((n) => n.nodeId === "work").direction =
        "Use the revised label";
      for (const n of graph.nodes) if (rerun.includes(n.nodeId)) n.generation++;
      window.directionStream.dispatchEvent(
        new MessageEvent("ralph", {
          data: JSON.stringify({
            seq: seq + 1,
            timestamp: new Date().toISOString(),
            type: "graph.revised",
            payload: {
              graph,
              direction: {
                nodeId: "work",
                commandId,
                rerun,
                reused: ["right"],
              },
            },
          }),
        }),
      );
    },
    { graph, seq: snapshot.seq, commandId: request.commandId },
  );
  await expect(page.getByRole("status")).toContainText(
    "다시 사용한 작업 right.",
  );
  await expect(page.locator(".worker-direction")).toHaveText(
    "Use the revised label",
  );
});

test("loads Galmuri, keeps completed graphs and zooms around the pointer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      [...document.fonts]
        .filter(
          (font) => font.family === "Galmuri11" && font.status === "loaded",
        )
        .map((font) => font.weight)
        .sort(),
    ),
  ).toEqual(["400", "700"]);
  await expect(page.locator(".run-item[aria-current] .lamp")).toHaveCSS(
    "background-color",
    "rgb(45, 187, 128)",
  );

  const canvas = page.locator(".canvas");
  const box = await canvas.boundingBox();
  const viewport = page.locator(".react-flow__viewport");
  const readViewport = () =>
    viewport.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
  await expect.poll(async () => (await readViewport()).y).toBeGreaterThan(80);
  const before = await readViewport();
  const x = box.width / 3;
  const y = box.height / 3;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.wheel(0, -150);
  await expect
    .poll(async () => (await readViewport()).zoom)
    .toBeGreaterThan(before.zoom);
  const after = await readViewport();
  expect(
    Math.abs((x - before.x) / before.zoom - (x - after.x) / after.zoom),
  ).toBeLessThan(1);
  expect(
    Math.abs((y - before.y) / before.zoom - (y - after.y) / after.zoom),
  ).toBeLessThan(1);

  await page.getByRole("button", { name: "다크 테마" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(canvas).toHaveCSS("background-color", "rgb(26, 31, 51)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
});

async function observeDashboardEvents(page) {
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      constructor() {
        super();
        window.dashboardEventStream = this;
      }
      close() {}
    };
  });
  const { runs } = await (await page.request.get("/api/v2/runs")).json();
  const path = `/api/v2/runs/${runs[0].runId}`;
  const snapshot = await (await page.request.get(path)).json();
  const graph = await (await page.request.get(`${path}/graph`)).json();
  let cursor = snapshot.seq;
  const send = (type, payload) => page.evaluate((event) => {
    window.dashboardEventStream.dispatchEvent(
      new MessageEvent("ralph", { data: JSON.stringify(event) }),
    );
  }, { seq: ++cursor, timestamp: new Date().toISOString(), type, payload });
  return { path, snapshot, graph, send };
}

test("a packet reaches the end of its edge and a resolved alert clears", async ({ page }) => {
  const { path, snapshot, send } = await observeDashboardEvents(page);
  snapshot.status = "running";
  snapshot.nodes.validate = { status: "running", generation: 0, iteration: 0 };
  await page.route(`**${path}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto("/");
  await page.waitForFunction(() => window.dashboardEventStream);
  const packet = page.locator(".data-packet");
  await expect(packet).toHaveCount(1);
  const distances = await packet.evaluate(async (element) => {
    const travel = element.getAnimations()[0];
    travel.pause();
    await travel.ready;
    const path = element.parentElement.querySelector("path.react-flow__edge-path");
    const samples = [];
    for (const fraction of [0.15, 0.45, 0.9]) {
      travel.currentTime = fraction * travel.effect.getComputedTiming().duration;
      await new Promise(requestAnimationFrame);
      const expected = path.getPointAtLength(fraction * path.getTotalLength())
        .matrixTransform(path.getScreenCTM());
      const circle = element.querySelector("circle:last-child").getBoundingClientRect();
      samples.push(Math.hypot(expected.x - circle.x - circle.width / 2,
        expected.y - circle.y - circle.height / 2));
    }
    travel.currentTime = 700;
    return samples;
  });
  for (const distance of distances) expect(distance).toBeLessThan(1);

  await send("run.status", { status: "awaiting_input", message: "Review requested" });
  const toast = page.locator(".report-toast");
  await expect(toast).toBeVisible();
  await send("node.status", { nodeId: "validate", status: "completed", generation: 0 });
  await send("run.status", { status: "completed" });
  await expect(page.locator('.node[data-tone="done"]')).toHaveCount(4);
  await expect(toast).toHaveCount(0);
  await expect(packet).toHaveCount(1);
  await packet.evaluate((element) => {
    const travel = element.getAnimations()[0];
    travel.playbackRate = 8;
    travel.play();
  });
  await expect(packet).toHaveCount(0);
});
