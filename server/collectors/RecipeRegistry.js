/**
 * RecipeRegistry — named deployment recipes, separate from SparkRegistry's physical
 * hosts. Recipes share compute nodes and are mutually exclusive serving deployments:
 * TP2 on head+worker, TP3 on head+worker+Atom, or a single-node worker deployment.
 *
 * Deliberately config, not code: server/config/recipes.json lists every recipe's nodes,
 * start/stop/status commands, and health-check port. Adding a sixth recipe later means
 * editing that file, not this class.
 * Required `tp` and `requiredNodes` metadata describe the complete compute topology,
 * independent of `nodes` (launcher/status/health commands). A required-node selector
 * contains exactly one `role` or `sparkId`; each must resolve uniquely.
 *
 * One more OPTIONAL per-node field ties a recipe into Model Registry orchestration (see
 * recipeActions.js's syncModelsForRecipe):
 *   - `modelIds`: array of ids tracked in ModelRegistry (config/models.json). When set,
 *     switchRecipe pulls each one onto this node's own `modelFolder` (using rsync's
 *     quick check, one at a time) before starting it. Explicit model sync still verifies
 *     SHA256. A node needing a weight tree plus a separately-sourced component lists
 *     multiple ids; omit entirely for a node that provisions its weights another way.
 * Not assumed present — a recipe with no model tracked yet works exactly as before,
 * unchanged. Everything else about a node's files (.env, checked-out repo, patches) is
 * ansible's job, applied by the relevant playbook run ahead of any activate — switchRecipe
 * only starts/stops/health-checks whatever is already provisioned there.
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

  /** Resolve explicit compute dependencies; launcher nodes are not the TP topology. */
  resolveRequiredNodes(recipe) {
    if (!Number.isInteger(recipe.tp) || recipe.tp < 1 ||
        !Array.isArray(recipe.requiredNodes) || recipe.requiredNodes.length === 0) {
      throw new Error(`Recipe ${recipe.id} requires tp and requiredNodes metadata`);
    }
    const sparks = recipe.requiredNodes.map((selector) => {
      if (!selector || typeof selector !== "object" || Array.isArray(selector) ||
          Object.keys(selector).length !== 1 ||
          !["role", "sparkId"].includes(Object.keys(selector)[0])) {
        throw new Error(`Recipe ${recipe.id} has an invalid requiredNodes selector`);
      }
      const key = selector.sparkId !== undefined ? "sparkId" : "role";
      const value = selector[key];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Recipe ${recipe.id} has an invalid requiredNodes ${key}`);
      }
      const matches = this.sparkRegistry.sparks.filter(
        (spark) => key === "sparkId" ? spark.id === value : spark.role === value
      );
      if (matches.length !== 1) {
        throw new Error(`Recipe ${recipe.id} required node ${key}=${value}: ${matches.length ? "ambiguous" : "no Spark configured"}`);
      }
      return matches[0];
    });
    if (new Set(sparks.map((spark) => spark.id)).size !== sparks.length ||
        sparks.length !== recipe.tp) {
      throw new Error(`Recipe ${recipe.id} TP${recipe.tp} does not match its unique required nodes`);
    }
    for (const node of recipe.nodes) {
      const spark = this._sparkForNode(node);
      if (!spark || !sparks.some((required) => required.id === spark.id)) {
        throw new Error(`Recipe ${recipe.id} launcher node is missing, ambiguous, or not a required node`);
      }
    }
    return sparks;
  }

  /** Resolve a launcher node without guessing when configuration is ambiguous. */
  _sparkForNode(node) {
    const matches = this.sparkRegistry.sparks.filter(
      (spark) => node.sparkId ? spark.id === node.sparkId : spark.role === node.role
    );
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Probe one recipe node's own statusCmd over SSH. Never throws — a probe failure (SSH down,
   * command missing, node powered off) just means "not running", the same as a clean
   * not-running status output.
   * @returns {Promise<{ role: string, running: boolean, detail: string }>}
   */
  async _probeNode(node, { getOnline, signal } = {}) {
    signal?.throwIfAborted();
    const spark = this._sparkForNode(node);
    if (!spark) {
      return { role: node.role, running: false, detail: `no Spark configured for role ${node.role}` };
    }
    if (getOnline && getOnline(spark.id) !== true) {
      return { role: node.role, running: false, detail: "node offline" };
    }
    try {
      const out = await sshExec(spark, `cd ${node.workdir} && ${node.statusCmd}`, {
        timeoutMs: STATUS_TIMEOUT_MS, signal,
      });
      const running = new RegExp(node.runningPattern).test(out);
      return { role: node.role, running, detail: out.slice(0, 2000) };
    } catch (err) {
      signal?.throwIfAborted();
      return { role: node.role, running: false, detail: err.message };
    }
  }

  /**
   * Probe every node of one recipe. A recipe is "active" only when ALL of its nodes report
   * running — a TP2 recipe with only its head container up is a half-started or half-stopped
   * transition, not a usable serving state.
   * @returns {Promise<{ id: string, active: boolean, nodes: Array }>}
   */
  async probeRecipe(recipe, options = {}) {
    if (options.getOnline) {
      // A launcher's status command may itself SSH to the other TP ranks. Do not
      // invoke it when a dependency is offline (including unrelated recipes).
      let detail;
      try {
        const required = this.resolveRequiredNodes(recipe);
        if (required.some((spark) => options.getOnline(spark.id) !== true)) {
          detail = "required node offline";
        }
      } catch (err) {
        detail = err.message;
      }
      if (detail) {
        return {
          id: recipe.id,
          active: false,
          nodes: recipe.nodes.map((node) => ({ role: node.role, running: false, detail })),
        };
      }
    }
    const nodes = await Promise.all(recipe.nodes.map((n) => this._probeNode(n, options)));
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
  async list(options = {}) {
    const probed = await Promise.all(this._recipes.map((r) => this.probeRecipe(r, options)));
    const activeOnes = probed.filter((p) => p.active);
    return {
      recipes: this._recipes.map((r, i) => ({
        id: r.id,
        label: r.label,
        group: r.group,
        tp: r.tp,
        requiredNodes: r.requiredNodes,
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
