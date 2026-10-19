/**
 * Generic power-control client.
 *
 * SparkDash does not know what is behind a power endpoint. Each Spark may carry
 * a `powerControl` config:
 *
 *   {
 *     onUrl:  "http://kasa-mcp:8812/outlets/on",
 *     offUrl: "http://kasa-mcp:8812/outlets/off",
 *     target: "1",                 // this unit's id in the batch body
 *     method: "POST",              // GET/POST/PUT/PATCH
 *     headers: { ... },            // non-secret headers
 *     body: null,                  // optional base body; targets are merged in
 *     timeoutMs: 10000,
 *     tokenHeader: "Authorization",
 *     tokenPrefix: "Bearer "
 *   }
 *
 * The token itself is never stored in sparks.json: it comes from the encrypted
 * secrets store and is attached as `Authorization: Bearer <token>` by default.
 *
 * Batch contract: one request per distinct endpoint, with
 * `{"targets": ["1", "2", "3"]}`. The endpoint answers
 * `{"results": [{"target": "1", "ok": true}, ...]}`; a plain 2xx without a
 * `results` array is treated as success for every target in that request.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** True when this Spark has at least one power endpoint configured. */
export function hasPowerControl(spark) {
  return Boolean(spark?.powerControl?.onUrl || spark?.powerControl?.offUrl);
}

/** The target string sent in the batch body. Falls back to the Spark id. */
export function powerTarget(spark) {
  const target = spark?.powerControl?.target;
  return target == null || target === "" ? String(spark?.id ?? "") : String(target);
}

function endpointFor(spark, action) {
  return action === "on" ? spark?.powerControl?.onUrl : spark?.powerControl?.offUrl;
}

function groupKey(spark, action) {
  const pc = spark.powerControl;
  return JSON.stringify({
    url: endpointFor(spark, action),
    method: pc.method || "POST",
    headers: pc.headers || {},
    body: pc.body ?? null,
    timeoutMs: pc.timeoutMs || DEFAULT_TIMEOUT_MS,
    tokenHeader: pc.tokenHeader || "Authorization",
    tokenPrefix: pc.tokenPrefix ?? "Bearer ",
    token: spark.powerToken || "",
  });
}

/**
 * Turn a set of Sparks on or off. Sparks sharing the same endpoint config are
 * sent in one batch request; different endpoints get their own request.
 *
 * @param {object[]} sparks
 * @param {"on"|"off"} action
 * @param {{ fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ id: string, ok: boolean, skipped?: boolean, target?: string, error?: string|null, message?: string|null }>>}
 */
export async function powerAction(sparks, action, { fetchFn = fetch } = {}) {
  const results = [];
  const groups = new Map();

  for (const spark of sparks || []) {
    const url = endpointFor(spark, action);
    if (!url) {
      results.push({
        id: spark.id,
        ok: false,
        skipped: true,
        error: `No power-${action} endpoint configured`,
      });
      continue;
    }
    const key = groupKey(spark, action);
    if (!groups.has(key)) {
      groups.set(key, {
        config: spark.powerControl,
        token: spark.powerToken || "",
        sparks: [],
        targets: [],
      });
    }
    const group = groups.get(key);
    group.sparks.push(spark);
    group.targets.push(powerTarget(spark));
  }

  for (const group of groups.values()) {
    try {
      const payload = await sendBatch(group, action, fetchFn);
      const byTarget = new Map();
      if (Array.isArray(payload?.results)) {
        for (const item of payload.results) {
          if (item && item.target != null) byTarget.set(String(item.target), item);
        }
      }
      for (const spark of group.sparks) {
        const target = powerTarget(spark);
        const item = byTarget.get(target);
        if (item) {
          results.push({
            id: spark.id,
            ok: item.ok !== false,
            target,
            error: item.ok === false ? item.error || "Power endpoint reported failure" : null,
            message: item.message || null,
          });
        } else if (byTarget.size === 0) {
          // A plain 2xx is the common "all targets accepted" answer.
          results.push({ id: spark.id, ok: true, target });
        } else {
          results.push({
            id: spark.id,
            ok: false,
            target,
            error: `Power endpoint returned no result for target ${target}`,
          });
        }
      }
    } catch (err) {
      const message = err?.message || String(err);
      for (const spark of group.sparks) {
        results.push({ id: spark.id, ok: false, target: powerTarget(spark), error: message });
      }
    }
  }

  return results;
}

export function powerOn(sparks, opts) {
  return powerAction(sparks, "on", opts);
}

export function powerOff(sparks, opts) {
  return powerAction(sparks, "off", opts);
}

async function sendBatch(group, action, fetchFn) {
  const pc = group.config;
  const method = String(pc.method || "POST").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(pc.headers || {}) };
  if (group.token) {
    headers[pc.tokenHeader || "Authorization"] = `${pc.tokenPrefix ?? "Bearer "}${group.token}`;
  }

  let url = endpointFor({ powerControl: pc }, action);
  let body;
  if (method === "GET") {
    const parsed = new URL(url);
    parsed.searchParams.set("targets", group.targets.join(","));
    url = parsed.toString();
  } else if (typeof pc.body === "string") {
    body = pc.body.replace("{{targets}}", JSON.stringify(group.targets));
  } else {
    body = JSON.stringify({ ...(pc.body || {}), targets: group.targets });
  }

  const res = await fetchFn(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(pc.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  const text = await readLimited(res);
  if (!res.ok) {
    throw new Error(`Power endpoint ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function readLimited(res) {
  const text = await res.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}
