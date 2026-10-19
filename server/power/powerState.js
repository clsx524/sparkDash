/**
 * Persisted power-cycle state.
 *
 * The active recipe is inferred live by RecipeRegistry, so it disappears the
 * moment the nodes power off. Shutdown-all captures it here first; wake-all
 * reads it back and re-activates it once the nodes are online.
 */
import fs from "fs";
import { POWER_STATE_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

const DEFAULTS = Object.freeze({
  lastActiveRecipeId: null,
  lastActiveRecipeIds: [],
  capturedAt: null,
  lastShutdownAt: null,
  lastWakeAt: null,
});

/** Read the state file; missing/corrupt files fall back to defaults. */
export function loadPowerState() {
  try {
    const raw = fs.readFileSync(POWER_STATE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULTS };
    }
    return {
      lastActiveRecipeId:
        typeof parsed.lastActiveRecipeId === "string" ? parsed.lastActiveRecipeId : null,
      lastActiveRecipeIds: Array.isArray(parsed.lastActiveRecipeIds)
        ? parsed.lastActiveRecipeIds.filter((id) => typeof id === "string")
        : [],
      capturedAt: Number.isFinite(parsed.capturedAt) ? parsed.capturedAt : null,
      lastShutdownAt: Number.isFinite(parsed.lastShutdownAt) ? parsed.lastShutdownAt : null,
      lastWakeAt: Number.isFinite(parsed.lastWakeAt) ? parsed.lastWakeAt : null,
    };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[powerState] could not read ${POWER_STATE_JSON_PATH}: ${err.message}`);
    }
    return { ...DEFAULTS };
  }
}

/** Write the state atomically (0600; no secrets, but it is runtime state). */
export function savePowerState(state) {
  const next = { ...DEFAULTS, ...state };
  atomicWrite(POWER_STATE_JSON_PATH, JSON.stringify(next, null, 2) + "\n", 0o600);
  return next;
}

/**
 * Record the recipe(s) that were active when a shutdown started.
 * `activeIds` is the full live set; `activeId` is the single unambiguous one
 * (null when there is no active recipe or a conflict).
 */
export function recordActiveRecipe(activeId, activeIds = []) {
  return savePowerState({
    ...loadPowerState(),
    lastActiveRecipeId: activeId || null,
    lastActiveRecipeIds: Array.isArray(activeIds) ? activeIds : [],
    capturedAt: Date.now(),
  });
}

export function recordShutdown() {
  return savePowerState({ ...loadPowerState(), lastShutdownAt: Date.now() });
}

export function recordWake() {
  return savePowerState({ ...loadPowerState(), lastWakeAt: Date.now() });
}
