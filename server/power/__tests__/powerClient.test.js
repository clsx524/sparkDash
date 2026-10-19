/**
 * Generic power client tests. A local HTTP server stands in for the Kasa MCP
 * (or any other controller); no real outlet is ever touched.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { powerOn, powerOff, hasPowerControl, powerTarget } from "../powerClient.js";

async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function spark(id, target, base, extra = {}) {
  return {
    id,
    name: id,
    powerControl: {
      onUrl: `${base}/outlets/on`,
      offUrl: `${base}/outlets/off`,
      target,
      method: "POST",
      timeoutMs: 5000,
      ...extra,
    },
    powerToken: "secret-token",
  };
}

test("hasPowerControl and powerTarget", () => {
  assert.equal(hasPowerControl({ powerControl: { onUrl: "http://x/on" } }), true);
  assert.equal(hasPowerControl({ powerControl: { offUrl: "http://x/off" } }), true);
  assert.equal(hasPowerControl({ powerControl: null }), false);
  assert.equal(powerTarget({ id: "a", powerControl: { target: "1" } }), "1");
  assert.equal(powerTarget({ id: "a", powerControl: {} }), "a");
});

test("powerOn batches sparks that share an endpoint", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { target: "1", ok: true },
            { target: "2", ok: true },
          ],
        })
      );
    },
    async (base, requests) => {
      const results = await powerOn([spark("a", "1", base), spark("b", "2", base)]);
      assert.equal(requests.length, 1, "one batch request for the shared endpoint");
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].url, "/outlets/on");
      assert.equal(requests[0].headers.authorization, "Bearer secret-token");
      assert.deepEqual(JSON.parse(requests[0].body), { targets: ["1", "2"] });
      assert.deepEqual(
        results.map((r) => [r.id, r.ok, r.target]),
        [
          ["a", true, "1"],
          ["b", true, "2"],
        ]
      );
    }
  );
});

test("powerOff uses the off URL and maps per-target failures", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { target: "1", ok: true },
            { target: "2", ok: false, error: "outlet busy" },
          ],
        })
      );
    },
    async (base, requests) => {
      const results = await powerOff([spark("a", "1", base), spark("b", "2", base)]);
      assert.equal(requests[0].url, "/outlets/off");
      assert.equal(results[0].ok, true);
      assert.equal(results[1].ok, false);
      assert.match(results[1].error, /outlet busy/);
    }
  );
});

test("different endpoints get separate requests", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    },
    async (base, requests) => {
      const a = spark("a", "1", base);
      const b = spark("b", "2", base);
      b.powerControl.onUrl = `${base}/other/on`;
      const results = await powerOn([a, b]);
      assert.equal(requests.length, 2);
      assert.equal(results.every((r) => r.ok), true);
    }
  );
});

test("a non-2xx response fails every spark in that group", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "device unreachable" }));
    },
    async (base) => {
      const results = await powerOn([spark("a", "1", base), spark("b", "2", base)]);
      assert.equal(results.length, 2);
      assert.equal(results.every((r) => r.ok === false), true);
      assert.match(results[0].error, /502/);
      assert.doesNotMatch(results[0].error, /secret-token/);
    }
  );
});

test("a spark without an endpoint is skipped", async () => {
  const results = await powerOn([{ id: "a", powerControl: null }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].skipped, true);
  assert.match(results[0].error, /No power-on endpoint/);
});

test("GET appends targets as a query parameter", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    },
    async (base, requests) => {
      const s = spark("a", "1", base, { method: "GET" });
      await powerOn([s]);
      assert.equal(requests[0].method, "GET");
      assert.equal(requests[0].url, "/outlets/on?targets=1");
    }
  );
});
