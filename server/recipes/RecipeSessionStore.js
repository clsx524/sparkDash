import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { quarantineCorrupt } from "../util/atomicWrite.js";
import { stripAnsi } from "../util/commandOutput.js";

const PHASES = new Set([
  "checking-nodes", "powering-on", "waiting-online", "checking-current-state", "stopping",
  "confirming-stopped", "clearing-conflicts", "syncing-model", "rechecking-nodes", "starting", "health-checking",
]);
const STATUSES = new Set(["running", "succeeded", "failed", "interrupted"]);
const STAGE_STATUSES = new Set([...STATUSES, "skipped"]);
const STREAMS = new Set(["action", "stdout", "stderr"]);
const LINE_BYTES = 16 * 1024;
const WRITE_DELAY_MS = 500;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const copy = (value) => structuredClone(value);
const timestamp = (value) => Number.isFinite(value) && value >= 0;
const nullableText = (value) => value === null || typeof value === "string";
const nullableTime = (value) => value === null || timestamp(value);
const plainText = (value) => stripAnsi(String(value)).replace(CONTROL_RE, "").replace(/\r\n?/g, "\n");
// Include entry metadata so many short/empty lines cannot evade the output budget.
const logBytes = (line) => Buffer.byteLength(JSON.stringify(line), "utf8") + 1;

export function isValidRecipeSessionId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

function prefix(text, bytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function summary(session) {
  const { stages, ...result } = session;
  return copy(result);
}

function validRecord(record, id) {
  if (!record || record.id !== id || !isValidRecipeSessionId(id) || typeof record.targetId !== "string" ||
      typeof record.label !== "string" || !Number.isFinite(record.tp) || !Array.isArray(record.requiredNodes) ||
      !record.requiredNodes.every((node) => node && typeof node.id === "string" && typeof node.name === "string") ||
      !STATUSES.has(record.status) || !(record.phase === null || PHASES.has(record.phase) || ["done", "failed", "interrupted"].includes(record.phase)) ||
      !timestamp(record.startedAt) || !timestamp(record.updatedAt) || record.updatedAt < record.startedAt ||
      !nullableTime(record.finishedAt) || !nullableText(record.error) || !nullableText(record.storageError) ||
      !Number.isSafeInteger(record.version) || record.version < 1 || !Number.isSafeInteger(record.lastSeq) || record.lastSeq < 0 ||
      typeof record.logsTruncated !== "boolean" || !Array.isArray(record.stages) ||
      (record.status === "running") !== (record.finishedAt === null)) return false;
  let seq = 0;
  const ids = new Set();
  for (const stage of record.stages) {
    if (!stage || typeof stage.id !== "string" || ids.has(stage.id) || !PHASES.has(stage.phase) || !STAGE_STATUSES.has(stage.status) ||
        !timestamp(stage.startedAt) || !timestamp(stage.updatedAt) || stage.updatedAt < stage.startedAt ||
        !nullableTime(stage.finishedAt) || !Array.isArray(stage.pendingNodes) || !stage.pendingNodes.every((node) => typeof node === "string") ||
        !nullableText(stage.message) || !Array.isArray(stage.logs) ||
        (stage.status === "running") !== (stage.finishedAt === null) ||
        !(stage.progress === null || (stage.progress && Number.isFinite(stage.progress.percent) &&
          (stage.progress.etaSeconds === null || Number.isFinite(stage.progress.etaSeconds)) && typeof stage.progress.source === "string"))) return false;
    ids.add(stage.id);
    for (const log of stage.logs) {
      if (!log || !Number.isSafeInteger(log.seq) || log.seq <= seq || log.seq > record.lastSeq || !timestamp(log.ts) ||
          !STREAMS.has(log.stream) || typeof log.text !== "string" ||
          !(log.nodeId === undefined || typeof log.nodeId === "string") || !(log.nodeName === undefined || typeof log.nodeName === "string")) return false;
      seq = log.seq;
    }
  }
  const running = record.stages.filter((stage) => stage.status === "running");
  return record.status === "running" ? running.length <= 1 && (!running.length || running[0] === record.stages.at(-1)) : running.length === 0;
}

/** Per-session records are the durable source of truth; no separately rewritten history index. */
export class RecipeSessionStore {
  constructor({ dir, now = Date.now, onChange = () => {}, maxSessions = 50, maxOutputBytes = 2 * 1024 * 1024 }) {
    if (typeof dir !== "string" || !dir) throw new Error("Recipe session directory is required");
    this.dir = dir;
    this.now = now;
    this.onChange = onChange;
    this.maxSessions = Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : 50;
    this.maxOutputBytes = Number.isInteger(maxOutputBytes) && maxOutputBytes >= 0 ? maxOutputBytes : 2 * 1024 * 1024;
    this._sessions = new Map();
    this._private = new Map();
    this._clock = 0;
    this._load();
  }

  _tick() {
    this._clock = Math.max(this.now(), this._clock + 1);
    return this._clock;
  }

  _text(id, value) {
    let text = plainText(value);
    for (const secret of this._private.get(id)?.secrets ?? []) text = text.split(secret).join("[REDACTED]");
    return text.replace(/\b(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
      .replace(/\b(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  }

  _short(id, value) {
    return value == null ? null : prefix(this._text(id, value), LINE_BYTES);
  }

  _file(id) {
    if (!isValidRecipeSessionId(id)) throw new Error("Invalid recipe session id");
    return path.join(this.dir, `${id}.json`);
  }

  _write(session) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this._file(session.id);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(session) + "\n", { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* no temporary file */ }
      throw error;
    }
  }

  _notify(session) {
    try { this.onChange(summary(session)); }
    catch (error) { console.error("[recipe-sessions] Subscriber failed:", this._short(session.id, error?.message ?? error)); }
  }

  _persist(session, { notify = true } = {}) {
    const state = this._private.get(session.id);
    clearTimeout(state.timer);
    state.timer = null;
    const oldError = session.storageError;
    session.storageError = null;
    try {
      this._write(session);
      state.dirty = false;
      if (oldError !== null) {
        session.updatedAt = this._tick();
        session.version++;
        this._write(session);
        if (notify) this._notify(session);
      }
    } catch (error) {
      session.storageError = this._short(session.id, `Could not persist Apply session: ${error?.message ?? error}`);
      state.dirty = true;
      if (session.storageError !== oldError) {
        session.updatedAt = this._tick();
        session.version++;
        if (notify) this._notify(session);
      }
      console.error("[recipe-sessions]", session.storageError);
    }
  }

  _changed(session, immediate) {
    session.updatedAt = this._tick();
    session.version++;
    const state = this._private.get(session.id);
    state.dirty = true;
    if (immediate) this._persist(session);
    else if (!state.timer) {
      state.timer = setTimeout(() => this._persist(session), WRITE_DELAY_MS);
      state.timer.unref?.();
    }
    this._notify(session);
  }

  _bound(session) {
    const state = this._private.get(session.id);
    while (state.bytes > this.maxOutputBytes) {
      const stage = session.stages.find((item) => item.logs.length);
      if (!stage) break;
      const removed = stage.logs.shift();
      state.bytes -= logBytes(removed);
      session.logsTruncated = true;
    }
  }

  _load() {
    let files;
    try { files = fs.readdirSync(this.dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error(`Could not read recipe session directory: ${error.message}`);
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const id = file.name.slice(0, -5);
      if (!isValidRecipeSessionId(id)) continue;
      let loaded;
      try {
        loaded = JSON.parse(fs.readFileSync(this._file(id), "utf8"));
        if (!validRecord(loaded, id)) throw new Error("Invalid session record");
      } catch {
        quarantineCorrupt(this._file(id), "recipe-sessions", new Error("Invalid session record"));
        continue;
      }
      // Rebuild the public shape explicitly: unknown/private disk properties never escape.
      const session = {
        id, targetId: loaded.targetId, label: this._short(id, loaded.label), tp: loaded.tp,
        requiredNodes: loaded.requiredNodes.map((node) => ({ id: node.id, name: this._short(id, node.name) })),
        status: loaded.status, phase: loaded.phase, startedAt: loaded.startedAt, updatedAt: loaded.updatedAt,
        finishedAt: loaded.finishedAt, error: this._short(id, loaded.error), version: loaded.version,
        lastSeq: loaded.lastSeq, logsTruncated: loaded.logsTruncated, storageError: this._short(id, loaded.storageError),
        stages: loaded.stages.map((stage) => ({
          id: stage.id, phase: stage.phase, status: stage.status, startedAt: stage.startedAt,
          updatedAt: stage.updatedAt, finishedAt: stage.finishedAt, pendingNodes: [...stage.pendingNodes],
          progress: stage.progress === null ? null : {
            percent: stage.progress.percent, etaSeconds: stage.progress.etaSeconds, source: this._short(id, stage.progress.source),
          },
          message: this._short(id, stage.message),
          logs: stage.logs.map((log) => ({ seq: log.seq, ts: log.ts, stream: log.stream,
            ...(log.nodeId === undefined ? {} : { nodeId: log.nodeId }),
            ...(log.nodeName === undefined ? {} : { nodeName: this._short(id, log.nodeName) }),
            text: prefix(this._text(id, log.text), LINE_BYTES),
          })),
        })),
      };
      this._sessions.set(id, session);
      this._private.set(id, { secrets: [], bytes: 0, dirty: false, timer: null });
      const state = this._private.get(id);
      for (let index = 0; index < session.stages.length; index++) {
        for (let line = 0; line < session.stages[index].logs.length; line++) {
          const log = session.stages[index].logs[line];
          if (log.text !== loaded.stages[index].logs[line].text) session.logsTruncated = true;
          state.bytes += logBytes(log);
        }
      }
      this._bound(session);
      this._clock = Math.max(this._clock, session.updatedAt);
      if (session.status === "running") {
        const time = this._tick();
        session.status = "interrupted";
        session.phase = "interrupted";
        session.finishedAt = session.updatedAt = time;
        session.error ||= "Apply was interrupted by a server restart. Outcome unknown; remote commands may still be running. It was not replayed.";
        session.version++;
        for (const stage of session.stages) {
          if (stage.status !== "running") continue;
          stage.status = "interrupted";
          stage.finishedAt = stage.updatedAt = time;
          stage.pendingNodes = [];
          stage.message = session.error;
        }
        state.dirty = true;
        this._persist(session, { notify: false });
      } else if (JSON.stringify(session) !== JSON.stringify(loaded)) {
        state.dirty = true;
        this._persist(session, { notify: false });
      }
    }
    this._prune({ notify: false });
  }

  _ordered() {
    return [...this._sessions.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  }

  _prune({ notify = true } = {}) {
    const terminal = this._ordered().filter((session) => session.status !== "running");
    for (const session of terminal.slice(this.maxSessions)) {
      try { fs.unlinkSync(this._file(session.id)); }
      catch (error) {
        if (error.code !== "ENOENT") {
          const message = this._short(session.id, `Could not remove old Apply session: ${error.message}`);
          if (message !== session.storageError) {
            session.storageError = message;
            session.updatedAt = this._tick();
            session.version++;
            this._private.get(session.id).dirty = true;
            if (notify) this._notify(session);
          }
          console.error("[recipe-sessions]", message);
          continue;
        }
      }
      const state = this._private.get(session.id);
      clearTimeout(state.timer);
      this._sessions.delete(session.id);
      this._private.delete(session.id);
    }
  }

  start(input, { secrets = [] } = {}) {
    if (this._ordered().some((session) => session.status === "running")) throw new Error("An Apply session is already running");
    if (!input || typeof input.targetId !== "string" || !input.targetId || typeof input.label !== "string" ||
        !Number.isFinite(input.tp) || !Array.isArray(input.requiredNodes) ||
        !input.requiredNodes.every((node) => node && typeof node.id === "string" && typeof node.name === "string")) {
      throw new Error("Invalid recipe session input");
    }
    const id = randomUUID();
    const state = { secrets: [...new Set(secrets.filter((secret) => typeof secret === "string" && secret.length).map(plainText).filter(Boolean))]
      .sort((a, b) => b.length - a.length), bytes: 0, dirty: false, timer: null };
    this._private.set(id, state);
    const time = this._tick();
    const session = {
      id, targetId: input.targetId, label: this._short(id, input.label), tp: input.tp,
      requiredNodes: input.requiredNodes.map((node) => ({ id: node.id, name: this._short(id, node.name) })),
      status: "running", phase: null, startedAt: time, updatedAt: time, finishedAt: null,
      error: null, version: 1, lastSeq: 0, logsTruncated: false, storageError: null, stages: [],
    };
    try { this._write(session); }
    catch (error) {
      const message = this._short(id, error?.message ?? error);
      this._private.delete(id);
      console.error("[recipe-sessions] Could not start Apply session:", message);
      throw new Error(`Could not persist Apply session: ${message}`);
    }
    this._sessions.set(id, session);
    this._prune();
    this._notify(session);
    return copy(session);
  }

  recordProgress(id, update) {
    const session = isValidRecipeSessionId(id) ? this._sessions.get(id) : null;
    if (!session) return null;
    if (session.status !== "running" || !update) return copy(session);
    const phase = update.phase ?? session.phase;
    const terminal = phase === "done" ? "succeeded" : phase === "failed" ? "failed" : phase === "interrupted" ? "interrupted" : null;
    if (!terminal && !PHASES.has(phase)) return copy(session);
    const transition = phase !== session.phase;
    let stage = session.stages.at(-1);
    const time = this._tick();
    if (transition || terminal) {
      if (stage?.status === "running") {
        stage.status = terminal ?? "succeeded";
        stage.updatedAt = stage.finishedAt = time;
        stage.pendingNodes = [];
      }
      session.phase = phase;
      if (terminal) {
        session.status = terminal;
        session.finishedAt = time;
      } else {
        stage = { id: `${id}:${session.stages.length + 1}`, phase, status: "running", startedAt: time, updatedAt: time,
          finishedAt: null, pendingNodes: [], progress: null, message: null, logs: [] };
        session.stages.push(stage);
      }
    }
    let changed = transition || Boolean(terminal);
    if (stage) {
      if (update.pendingNodes !== undefined && !terminal && Array.isArray(update.pendingNodes)) {
        const pending = update.pendingNodes.filter((node) => typeof node === "string");
        if (JSON.stringify(stage.pendingNodes) !== JSON.stringify(pending)) { stage.pendingNodes = pending; changed = true; }
      }
      if (update.progress !== undefined) {
        const progress = update.progress === null ? null : {
          percent: Math.max(0, Math.min(100, Number(update.progress.percent) || 0)),
          etaSeconds: Number.isFinite(update.progress.etaSeconds) ? Math.max(0, update.progress.etaSeconds) : null,
          source: this._short(id, update.progress.source ?? "estimate"),
        };
        if (JSON.stringify(stage.progress) !== JSON.stringify(progress)) { stage.progress = progress; changed = true; }
      }
      if (update.message !== undefined || update.error != null) {
        const message = this._short(id, update.error ?? update.message);
        if (stage.message !== message) { stage.message = message; changed = true; }
      }
      if (changed) stage.updatedAt = time;
    }
    if (update.error != null) {
      const error = this._short(id, update.error);
      if (error.trim() && session.error !== error) { session.error = error; changed = true; }
    }
    if (changed) {
      this._changed(session, transition || Boolean(terminal));
      if (terminal) this._prune();
    }
    return copy(session);
  }

  appendLog(id, line) {
    const session = isValidRecipeSessionId(id) ? this._sessions.get(id) : null;
    if (!session) return null;
    const stage = session.stages.at(-1);
    if (session.status !== "running" || !stage || !line || !STREAMS.has(line.stream) || line.text == null) return summary(session);
    const text = this._text(id, line.text);
    if (!text) return summary(session);
    const state = this._private.get(id);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const value of lines) {
      const bounded = prefix(value, Math.min(LINE_BYTES, this.maxOutputBytes));
      if (bounded !== value) session.logsTruncated = true;
      const log = { seq: ++session.lastSeq, ts: this._tick(), stream: line.stream,
        ...(typeof line.nodeId === "string" ? { nodeId: line.nodeId } : {}),
        ...(typeof line.nodeName === "string" ? { nodeName: this._short(id, line.nodeName) } : {}), text: bounded };
      stage.logs.push(log);
      state.bytes += logBytes(log);
    }
    this._bound(session);
    stage.updatedAt = this._clock;
    this._changed(session, false);
    return summary(session);
  }

  get(id, { afterSeq } = {}) {
    if (!isValidRecipeSessionId(id)) return null;
    const session = this._sessions.get(id);
    if (!session) return null;
    const firstSeq = session.stages.find((stage) => stage.logs.length)?.logs[0].seq ?? session.lastSeq + 1;
    if (Number.isSafeInteger(afterSeq) && afterSeq >= 0) {
      return copy({
        ...session, firstSeq,
        stages: session.stages.map((stage) => ({
          ...stage, logs: stage.logs.filter((line) => line.seq > afterSeq),
        })),
      });
    }
    return copy({ ...session, firstSeq });
  }

  current() {
    const session = this._ordered()[0];
    return session ? this.get(session.id) : null;
  }

  summary() {
    const session = this._ordered()[0];
    return session ? summary(session) : null;
  }

  list() {
    return this._ordered().filter((session) => session.status !== "running").map(summary);
  }

  flush() {
    for (const session of this._sessions.values()) {
      if (this._private.get(session.id).dirty) this._persist(session);
    }
  }
}

export default RecipeSessionStore;
