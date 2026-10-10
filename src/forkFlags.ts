/**
 * Fork switches, kept in one file so upstream files only carry a one-token gate.
 *
 * Upstream's "launchers for your own models" (a per-Spark start.sh / stop.sh runner on the Overview
 * cards and the Spark page) is hidden: starting and stopping models here goes through the recipes
 * (RecipesDialog). The server routes stay; only the UI is gated.
 */
export const SHOW_MODEL_LAUNCHERS = false;
