/**
 * RecipeRegistry — named *deployment recipes* for the two-Spark pair, as opposed to the
 * physical-node config SparkRegistry already owns. A recipe is one of the mutually exclusive
 * ways this cluster's combined GPU memory can be occupied: one TP2 model across both nodes
 * (`dual-text-gen` group), or two independent single-node models, one per node
 * (`h3-plus-single-llm` group). Exactly one recipe — or none — is active at a time.
 *
 * Deliberately config, not code: server/config/recipes.json lists every recipe's nodes,
 * start/stop/status commands, and health-check port. Adding a sixth recipe later means
 * editing that file, not this class.
 *
 * Two more OPTIONAL per-node fields tie a recipe into Model Registry / config-generator
 * orchestration (see recipeActions.js's syncModelsForRecipe / renderConfigsForRecipe):
 *   - `modelId`: id of a model tracked in ModelRegistry (config/models.json). When set,
 *     switchRecipe pulls that model onto this node's own `modelFolder` (checksum-verified)
 *     before starting it. Omit for a node that provisions its weights another way.
 *   - `configScript`: filename of a generator script under the mounted RECIPE_CONFIG_DIR
 *     (e.g. generate-env-glm53-exl3.py). When set, switchRecipe copies it to this node's
 *     `workdir` and runs `python3 <configScript>` before starting. Omit if the node's
 *     recipe needs no generated config file.
 * Neither field is assumed present — a recipe with no models/configs tracked yet works
 * exactly as before, unchanged.
 *
 * Active state is NEVER trusted from a stored flag — it is inferred live, every call, by
 * SSHing each recipe's node(s) and running that recipe's own statusCmd. A flag can drift from
 * reality (a container crashed, someone ran a script by hand); a live probe cannot.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sshExec } from "./ssh.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_JSON_PATH =
  process.env.RECIPES_JSON_PATH || path.join(__dirname, "..", "config", "recipes.json");

const STATUS_TIMEOUT_MS = 15_000;

export class RecipeRegistry {
  /** @param {import("../sparks/SparkRegistry.js").SparkRegistry} sparkRegistry */
  constructor(sparkRegistry) {
    this.sparkRegistry = sparkRegistry;
    this._recipes = this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(RECIPES_JSON_PATH, "utf8");
    } catch (err) {
      console.warn(`[RecipeRegistry] could not read ${RECIPES_JSON_PATH}: ${err.message}`);
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("recipes.json must be a JSON array");
      return parsed;
    } catch (err) {
      console.warn(`[RecipeRegistry] could not parse ${RECIPES_JSON_PATH}: ${err.message}`);
      return [];
    }
  }

  /** All recipe definitions, unchanged from disk (no secrets in this file). */
  all() {
    return this._recipes;
  }

  get(id) {
    return this._recipes.find((r) => r.id === id) || null;
  }

  /** Distinct group ids across every recipe (drives the mutual-exclusion rule). */
  groups() {
    return [...new Set(this._recipes.map((r) => r.group))];
  }

  /** Find the live Spark for a recipe node by role ("head" | "worker"). */
  _sparkForNode(node) {
    return this.sparkRegistry.sparks.find((s) => s.role === node.role) || null;
  }

  /**
   * Probe one recipe node's own statusCmd over SSH. Never throws — a probe failure (SSH down,
   * command missing, node powered off) just means "not running", the same as a clean
   * not-running status output.
   * @returns {Promise<{ role: string, running: boolean, detail: string }>}
   */
  async _probeNode(node) {
    const spark = this._sparkForNode(node);
    if (!spark) {
      return { role: node.role, running: false, detail: `no Spark configured for role ${node.role}` };
    }
    try {
      const out = await sshExec(spark, `cd ${node.workdir} && ${node.statusCmd}`, {
        timeoutMs: STATUS_TIMEOUT_MS,
        noBatch: true,
      });
      const running = new RegExp(node.runningPattern).test(out);
      return { role: node.role, running, detail: out.slice(0, 2000) };
    } catch (err) {
      return { role: node.role, running: false, detail: err.message };
    }
  }

  /**
   * Probe every node of one recipe. A recipe is "active" only when ALL of its nodes report
   * running — a TP2 recipe with only its head container up is a half-started or half-stopped
   * transition, not a usable serving state.
   * @returns {Promise<{ id: string, active: boolean, nodes: Array }>}
   */
  async probeRecipe(recipe) {
    const nodes = await Promise.all(recipe.nodes.map((n) => this._probeNode(n)));
    return { id: recipe.id, active: nodes.length > 0 && nodes.every((n) => n.running), nodes };
  }

  /**
   * Live snapshot of every recipe plus which one (if any) is actually running.
   * Surfaces a conflict rather than silently picking one if more than one recipe's nodes all
   * report running at once — that is a broken state (e.g. two things sharing a node after a
   * manual intervention), not a normal outcome, and switching blind on top of it risks the
   * exact GPU-memory coexistence hang the qwen38-flash-next recipe's own README warns about.
   * @returns {Promise<{ recipes: Array, activeId: string | null, conflict: boolean }>}
   */
  async list() {
    const probed = await Promise.all(this._recipes.map((r) => this.probeRecipe(r)));
    const activeOnes = probed.filter((p) => p.active);
    return {
      recipes: this._recipes.map((r, i) => ({
        id: r.id,
        label: r.label,
        group: r.group,
        nodes: r.nodes.map((n) => ({ role: n.role, workdir: n.workdir })),
        active: probed[i].active,
        nodeStatus: probed[i].nodes,
      })),
      activeId: activeOnes.length === 1 ? activeOnes[0].id : null,
      conflict: activeOnes.length > 1,
      conflictIds: activeOnes.length > 1 ? activeOnes.map((p) => p.id) : [],
    };
  }
}
