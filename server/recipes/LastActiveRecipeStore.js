import fs from "fs";
import path from "path";
import { quarantineCorrupt } from "../util/atomicWrite.js";

const validId = (id) => typeof id === "string" && id.trim().length > 0;
const validTimestamp = (value) => Number.isFinite(value) && value >= 0;

/** A durable recipe pointer, independent of the bounded Apply-session history. */
export class LastActiveRecipeStore {
  constructor({ file, now = Date.now }) {
    if (typeof file !== "string" || !file) throw new Error("Last active recipe file is required");
    this.file = file;
    this.now = now;
    this._record = null;
    this._dirty = false;
    this._load();
  }

  _load() {
    let contents;
    try {
      contents = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error("Could not read last active recipe file");
    }
    let record;
    try {
      record = JSON.parse(contents);
      if (!record || !validId(record.id) || !validTimestamp(record.rememberedAt)) {
        throw new Error("Invalid last active recipe record");
      }
    } catch {
      quarantineCorrupt(this.file, "last-active-recipe", new Error("Invalid last active recipe record"));
      return;
    }
    // Only recipe identity and time belong on disk; never expose unknown fields.
    this._record = { id: record.id, rememberedAt: record.rememberedAt, storageError: null };
  }

  get() {
    return this._record === null ? null : { ...this._record };
  }

  remember(id, rememberedAt) {
    if (!validId(id)) throw new Error("Recipe id is required");
    const suppliedTime = rememberedAt !== undefined;
    const time = suppliedTime ? rememberedAt : this.now();
    if (!validTimestamp(time)) throw new Error("Invalid remembered recipe timestamp");
    // History seeding must not replace a more recent observation or successful Apply.
    if (suppliedTime && this._record && time < this._record.rememberedAt) return this.get();
    // Live-state polling of the same recipe must not rewrite its timestamp or file.
    if (this._record?.id === id) return this.get();
    this._record = {
      id,
      rememberedAt: Math.max(time, this._record?.rememberedAt ?? 0),
      storageError: this._record?.storageError ?? null,
    };
    this._dirty = true;
    return this.flush();
  }

  flush() {
    if (!this._dirty) return this.get();
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const { id, rememberedAt } = this._record;
      fs.writeFileSync(temporary, JSON.stringify({ id, rememberedAt }) + "\n", { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
      this._record.storageError = null;
      this._dirty = false;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* no temporary file */ }
      // Do not copy filesystem messages, paths, or arbitrary exception contents into API state.
      const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
        ? ` (${error.code})` : "";
      this._record.storageError = `Could not persist last active recipe${code}`;
    }
    return this.get();
  }
}
