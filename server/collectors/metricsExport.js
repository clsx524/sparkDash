/**
 * Prometheus text-exposition formatting for sparkDash's own already-collected
 * fleet state (SystemCollector + LlmProbe snapshots via orderedSnapshots()),
 * for an external Prometheus server to scrape at GET /metrics.
 *
 * Hand-rolled rather than pulling in prom-client: the exposition format is a
 * handful of lines per metric, this project already hand-rolls the *parsing*
 * side of the same format (LlmProbe's vLLM/SGLang/llama.cpp scrapers), and
 * the values here are a straight read of state this process already
 * maintains every 2s regardless of whether anything ever scrapes it -- no
 * new collection, no new SSH connections, just a different serialization of
 * data orderedSnapshots() already returns for the WebSocket payload.
 *
 * No unit conversions are performed on any value -- every number is passed
 * through in whatever scale SystemCollector/LlmProbe already use internally,
 * to avoid introducing a silent scale bug in a translation layer that has no
 * way to cross-check itself. Metric names are suffixed honestly instead of
 * normalized to Prometheus's own base-unit convention: `_percent` for a 0-100
 * value, `_ratio` for 0-1, `_mb` for the megabytes SystemCollector already
 * reports (matching its own formatMb() convention on the frontend).
 */

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render one metric family (HELP/TYPE header + sample lines). Samples with a
 * null/undefined/non-finite value are dropped silently -- a spark mid-reboot
 * or an LLM port with no reading yet should not emit `NaN` or `0` for a
 * value that was never actually measured; from Prometheus's point of view a
 * dropped sample and an absent target read the same (no data), which is the
 * honest answer here.
 * @param {string} name
 * @param {string} help
 * @param {"gauge"|"counter"} type
 * @param {Array<[Record<string,string>, number|null|undefined]>} samples
 * @returns {string}
 */
export function renderMetricFamily(name, help, type, samples) {
  const lines = [];
  for (const [labels, value] of samples) {
    if (value == null || !Number.isFinite(value)) continue;
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
      .join(",");
    lines.push(`${name}{${labelStr}} ${value}`);
  }
  if (lines.length === 0) return "";
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines].join("\n") + "\n";
}

/**
 * @param {Array<object>} snapshots - orderedSnapshots() output: one entry per tracked Spark,
 *   each shaped like SparkMonitor#snapshot()'s return value.
 * @returns {string} Prometheus text-exposition format (empty families omitted entirely).
 */
export function formatPrometheusMetrics(snapshots) {
  const up = [];
  const gpuTemp = [];
  const gpuUsage = [];
  const gpuPowerDraw = [];
  const gpuPowerLimit = [];
  const vramUsed = [];
  const vramTotal = [];
  const vramAvailable = [];
  const vramPercent = [];
  const cpuUsage = [];
  const cpuTemp = [];
  const cpuPowerDraw = [];
  const ramUsed = [];
  const ramTotal = [];
  const ramPercent = [];
  const umTotal = [];
  const umUsed = [];
  const umAvailable = [];
  const umGpuUsed = [];
  const umCpuUsed = [];
  const umPercent = [];

  const llmAvailable = [];
  const llmGenTps = [];
  const llmPrefillTps = [];
  const llmTotalOutputTokens = [];
  const llmKvCacheUsage = [];
  const llmRequestsRunning = [];
  const llmRequestsWaiting = [];
  const llmTtftP95 = [];
  const llmMtpAcceptance = [];
  const llmPrefixCacheHitRate = [];

  for (const s of snapshots || []) {
    if (!s || !s.id) continue;
    const spark = s.id;
    up.push([{ spark }, s.online ? 1 : 0]);

    const gpu = s.metrics?.gpu;
    if (gpu) {
      gpuTemp.push([{ spark }, gpu.temperature]);
      gpuUsage.push([{ spark }, gpu.usage]);
      gpuPowerDraw.push([{ spark }, gpu.power?.draw]);
      gpuPowerLimit.push([{ spark }, gpu.power?.limit]);
      vramUsed.push([{ spark }, gpu.vram?.used]);
      vramTotal.push([{ spark }, gpu.vram?.total]);
      vramAvailable.push([{ spark }, gpu.vram?.available]);
      vramPercent.push([{ spark }, gpu.vram?.percentage]);
    }
    const cpu = s.metrics?.cpu;
    if (cpu) {
      cpuUsage.push([{ spark }, cpu.usage]);
      cpuTemp.push([{ spark }, cpu.temperature]);
      cpuPowerDraw.push([{ spark }, cpu.draw]);
    }
    const ram = s.metrics?.ram;
    if (ram) {
      ramUsed.push([{ spark }, ram.used]);
      ramTotal.push([{ spark }, ram.total]);
      ramPercent.push([{ spark }, ram.percentage]);
    }
    const um = s.metrics?.unifiedMemory;
    if (um) {
      umTotal.push([{ spark }, um.total]);
      umUsed.push([{ spark }, um.used]);
      umAvailable.push([{ spark }, um.available]);
      umGpuUsed.push([{ spark }, um.gpuUsed]);
      umCpuUsed.push([{ spark }, um.cpuUsed]);
      umPercent.push([{ spark }, um.percentage]);
    }

    const llmEntries = Array.isArray(s.metrics?.llm) ? s.metrics.llm : [];
    const ports = Array.isArray(s.llmPorts) && s.llmPorts.length > 0 ? s.llmPorts : [s.llmPort];
    llmEntries.forEach((llm, i) => {
      if (!llm) return;
      const labels = { spark, port: String(ports[i] ?? ""), model: llm.modelId || "" };
      llmAvailable.push([labels, llm.available ? 1 : 0]);
      if (!llm.available) return;
      llmGenTps.push([labels, llm.generationTps]);
      llmPrefillTps.push([labels, llm.prefillTps]);
      llmTotalOutputTokens.push([labels, llm.totalOutputTokens]);
      llmKvCacheUsage.push([labels, llm.kvCacheUsage]);
      llmRequestsRunning.push([labels, llm.requestsRunning]);
      llmRequestsWaiting.push([labels, llm.requestsWaiting]);
      llmTtftP95.push([labels, llm.ttftP95Seconds]);
      llmMtpAcceptance.push([labels, llm.mtpAcceptanceRate]);
      llmPrefixCacheHitRate.push([labels, llm.prefixCacheHitRate]);
    });
  }

  const families = [
    ["sparkdash_up", "1 if this Spark is reachable, 0 otherwise.", "gauge", up],
    ["sparkdash_gpu_temperature_celsius", "GPU die temperature.", "gauge", gpuTemp],
    ["sparkdash_gpu_usage_percent", "GPU compute utilization, 0-100.", "gauge", gpuUsage],
    ["sparkdash_gpu_power_draw_watts", "GPU power draw.", "gauge", gpuPowerDraw],
    ["sparkdash_gpu_power_limit_watts", "GPU power limit.", "gauge", gpuPowerLimit],
    ["sparkdash_gpu_vram_used_mb", "GPU VRAM (unified-memory GPU share on GB10) used.", "gauge", vramUsed],
    ["sparkdash_gpu_vram_total_mb", "GPU VRAM (unified-memory total on GB10) total.", "gauge", vramTotal],
    ["sparkdash_gpu_vram_available_mb", "GPU VRAM (unified-memory) available.", "gauge", vramAvailable],
    ["sparkdash_gpu_vram_percent", "GPU VRAM used, 0-100.", "gauge", vramPercent],
    ["sparkdash_cpu_usage_percent", "Host CPU utilization, 0-100.", "gauge", cpuUsage],
    ["sparkdash_cpu_temperature_celsius", "CPU package temperature.", "gauge", cpuTemp],
    ["sparkdash_cpu_power_draw_watts", "CPU power draw (RAPL where available).", "gauge", cpuPowerDraw],
    ["sparkdash_ram_used_mb", "Host RAM used.", "gauge", ramUsed],
    ["sparkdash_ram_total_mb", "Host RAM total.", "gauge", ramTotal],
    ["sparkdash_ram_usage_percent", "Host RAM used, 0-100.", "gauge", ramPercent],
    ["sparkdash_unified_memory_total_mb", "GB10 unified CPU+GPU memory pool total.", "gauge", umTotal],
    ["sparkdash_unified_memory_used_mb", "GB10 unified memory used.", "gauge", umUsed],
    ["sparkdash_unified_memory_available_mb", "GB10 unified memory available.", "gauge", umAvailable],
    ["sparkdash_unified_memory_gpu_used_mb", "GB10 unified memory held by GPU allocations.", "gauge", umGpuUsed],
    ["sparkdash_unified_memory_cpu_used_mb", "GB10 unified memory held by CPU allocations.", "gauge", umCpuUsed],
    ["sparkdash_unified_memory_usage_percent", "GB10 unified memory used, 0-100.", "gauge", umPercent],
    ["sparkdash_llm_available", "1 if this LLM port is currently serving, 0 otherwise.", "gauge", llmAvailable],
    ["sparkdash_llm_generation_tokens_per_second", "Live decode throughput.", "gauge", llmGenTps],
    ["sparkdash_llm_prefill_tokens_per_second", "Live prefill throughput.", "gauge", llmPrefillTps],
    [
      "sparkdash_llm_total_output_tokens",
      "Cumulative generated tokens since this engine process started.",
      "counter",
      llmTotalOutputTokens,
    ],
    ["sparkdash_llm_kv_cache_usage_ratio", "Fraction of KV cache blocks in use, 0-1.", "gauge", llmKvCacheUsage],
    ["sparkdash_llm_requests_running", "Requests currently being decoded.", "gauge", llmRequestsRunning],
    ["sparkdash_llm_requests_waiting", "Requests queued, not yet scheduled.", "gauge", llmRequestsWaiting],
    ["sparkdash_llm_ttft_p95_seconds", "P95 time-to-first-token.", "gauge", llmTtftP95],
    [
      "sparkdash_llm_mtp_acceptance_ratio",
      "Speculative-decode draft acceptance rate, 0-1.",
      "gauge",
      llmMtpAcceptance,
    ],
    ["sparkdash_llm_prefix_cache_hit_ratio", "Prefix cache hit rate, 0-1.", "gauge", llmPrefixCacheHitRate],
  ];

  return families.map(([name, help, type, samples]) => renderMetricFamily(name, help, type, samples)).join("");
}
