import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatPrometheusMetrics, renderMetricFamily } from "../metricsExport.js";

test("renderMetricFamily: emits HELP/TYPE header plus one line per sample", () => {
  const text = renderMetricFamily("x_metric", "help text", "gauge", [
    [{ spark: "spark1" }, 42],
    [{ spark: "spark2" }, 7],
  ]);
  assert.equal(
    text,
    '# HELP x_metric help text\n# TYPE x_metric gauge\nx_metric{spark="spark1"} 42\nx_metric{spark="spark2"} 7\n'
  );
});

test("renderMetricFamily: no samples at all -> empty string, not a bare header", () => {
  assert.equal(renderMetricFamily("x_metric", "help", "gauge", []), "");
});

test("renderMetricFamily: null/undefined/NaN values are dropped, not emitted as 0 or NaN", () => {
  const text = renderMetricFamily("x_metric", "help", "gauge", [
    [{ spark: "spark1" }, null],
    [{ spark: "spark2" }, undefined],
    [{ spark: "spark3" }, NaN],
    [{ spark: "spark4" }, 5],
  ]);
  assert.equal(text, '# HELP x_metric help\n# TYPE x_metric gauge\nx_metric{spark="spark4"} 5\n');
});

test("renderMetricFamily: every sample dropped -> empty string (no dangling header)", () => {
  assert.equal(renderMetricFamily("x_metric", "help", "gauge", [[{ spark: "s" }, null]]), "");
});

test("renderMetricFamily: label values with quotes/backslashes/newlines are escaped", () => {
  const text = renderMetricFamily("x_metric", "help", "gauge", [
    [{ model: 'weird"name\\with\nstuff' }, 1],
  ]);
  assert.equal(text, '# HELP x_metric help\n# TYPE x_metric gauge\nx_metric{model="weird\\"name\\\\with\\nstuff"} 1\n');
});

// formatPrometheusMetrics: this is the actual /metrics response body — a
// wrong answer here either hides real fleet state from Prometheus or feeds
// it garbage (NaN/undefined samples, wrong scale, a metric that silently
// stops updating when a recipe stops).

test("formatPrometheusMetrics: empty snapshot list -> empty string", () => {
  assert.equal(formatPrometheusMetrics([]), "");
  assert.equal(formatPrometheusMetrics(null), "");
});

test("formatPrometheusMetrics: a spark with no metrics yet only emits sparkdash_up", () => {
  const text = formatPrometheusMetrics([{ id: "spark1", online: true, metrics: {} }]);
  assert.match(text, /sparkdash_up\{spark="spark1"\} 1/);
  assert.doesNotMatch(text, /sparkdash_gpu_/);
  assert.doesNotMatch(text, /sparkdash_cpu_/);
});

test("formatPrometheusMetrics: offline spark reports sparkdash_up 0", () => {
  const text = formatPrometheusMetrics([{ id: "spark2", online: false, metrics: {} }]);
  assert.match(text, /sparkdash_up\{spark="spark2"\} 0/);
});

test("formatPrometheusMetrics: full GPU/CPU/RAM/unified-memory snapshot renders every family", () => {
  const text = formatPrometheusMetrics([
    {
      id: "spark1",
      online: true,
      metrics: {
        gpu: {
          temperature: 62,
          usage: 88,
          power: { draw: 95, limit: 120 },
          vram: { used: 102400, total: 122880, available: 20480, percentage: 83.3 },
        },
        cpu: { usage: 45, temperature: 55, draw: 15 },
        ram: { used: 4096, total: 16384, percentage: 25 },
        unifiedMemory: { total: 122880, used: 112640, available: 10240, gpuUsed: 100000, cpuUsed: 12640, percentage: 91.7 },
      },
    },
  ]);
  assert.match(text, /sparkdash_gpu_temperature_celsius\{spark="spark1"\} 62/);
  assert.match(text, /sparkdash_gpu_usage_percent\{spark="spark1"\} 88/);
  assert.match(text, /sparkdash_gpu_power_draw_watts\{spark="spark1"\} 95/);
  assert.match(text, /sparkdash_gpu_vram_used_mb\{spark="spark1"\} 102400/);
  assert.match(text, /sparkdash_cpu_usage_percent\{spark="spark1"\} 45/);
  assert.match(text, /sparkdash_ram_usage_percent\{spark="spark1"\} 25/);
  assert.match(text, /sparkdash_unified_memory_gpu_used_mb\{spark="spark1"\} 100000/);
});

test("formatPrometheusMetrics: an available LLM port emits token/tps/request metrics with port+model labels", () => {
  const text = formatPrometheusMetrics([
    {
      id: "spark1",
      online: true,
      llmPort: 8888,
      llmPorts: [8888],
      metrics: {
        llm: [
          {
            available: true,
            modelId: "DeepSeek-v4.1-Flash-EXL3",
            generationTps: 42.5,
            prefillTps: 900,
            totalOutputTokens: 510363,
            kvCacheUsage: 0.48,
            requestsRunning: 2,
            requestsWaiting: 1,
            ttftP95Seconds: 0.8,
            mtpAcceptanceRate: 0.62,
            prefixCacheHitRate: 0.98,
          },
        ],
      },
    },
  ]);
  const labels = 'spark="spark1",port="8888",model="DeepSeek-v4.1-Flash-EXL3"';
  assert.match(text, new RegExp(`sparkdash_llm_available\\{${labels}\\} 1`));
  assert.match(text, new RegExp(`sparkdash_llm_generation_tokens_per_second\\{${labels}\\} 42.5`));
  assert.match(text, new RegExp(`sparkdash_llm_total_output_tokens\\{${labels}\\} 510363`));
  assert.match(text, new RegExp(`sparkdash_llm_kv_cache_usage_ratio\\{${labels}\\} 0.48`));
  assert.match(text, new RegExp(`sparkdash_llm_requests_waiting\\{${labels}\\} 1`));
});

test("formatPrometheusMetrics: an unavailable LLM port reports sparkdash_llm_available=0 and nothing else (no stale token/tps values)", () => {
  const text = formatPrometheusMetrics([
    {
      id: "spark1",
      online: true,
      llmPort: 8888,
      llmPorts: [8888],
      metrics: {
        llm: [{ available: false, modelId: null, generationTps: 0, totalOutputTokens: 12345 }],
      },
    },
  ]);
  assert.match(text, /sparkdash_llm_available\{spark="spark1",port="8888",model=""\} 0/);
  assert.doesNotMatch(text, /sparkdash_llm_total_output_tokens/);
  assert.doesNotMatch(text, /sparkdash_llm_generation_tokens_per_second/);
});

test("formatPrometheusMetrics: multiple LLM ports on one spark are zipped with llmPorts by index, not conflated", () => {
  const text = formatPrometheusMetrics([
    {
      id: "beast",
      online: true,
      llmPort: 8020,
      llmPorts: [8020, 8021],
      metrics: {
        llm: [
          { available: true, modelId: "qwen38", generationTps: 30, totalOutputTokens: 1 },
          { available: true, modelId: "gemma4", generationTps: 60, totalOutputTokens: 2 },
        ],
      },
    },
  ]);
  assert.match(
    text,
    /sparkdash_llm_generation_tokens_per_second\{spark="beast",port="8020",model="qwen38"\} 30/
  );
  assert.match(
    text,
    /sparkdash_llm_generation_tokens_per_second\{spark="beast",port="8021",model="gemma4"\} 60/
  );
});

test("formatPrometheusMetrics: multiple sparks each get their own labeled series", () => {
  const text = formatPrometheusMetrics([
    { id: "spark1", online: true, metrics: { cpu: { usage: 10 } } },
    { id: "spark2", online: true, metrics: { cpu: { usage: 20 } } },
  ]);
  assert.match(text, /sparkdash_cpu_usage_percent\{spark="spark1"\} 10/);
  assert.match(text, /sparkdash_cpu_usage_percent\{spark="spark2"\} 20/);
});

test("formatPrometheusMetrics: entries with no id are skipped rather than throwing", () => {
  assert.doesNotThrow(() => formatPrometheusMetrics([null, {}, { id: "spark1", online: true, metrics: {} }]));
});
