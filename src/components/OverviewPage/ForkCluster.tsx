// Fork-only cluster summary for the Overview, kept out of OverviewPage.tsx so an upstream
// rewrite of that file merges without touching it.
import type { SparkSnapshot } from "../../api/types";
import { ClusterSummary } from "./ClusterSummary";
import { findHead } from "./clusterModel";

/** A "cluster" is a head plus at least one worker; anything else keeps the plain overview. */
export function ForkClusterTop({
  sparks,
  temperatureUnit,
}: {
  sparks: SparkSnapshot[];
  temperatureUnit: "celsius" | "fahrenheit";
}) {
  return findHead(sparks) !== null && sparks.length > 1 ? (
    <ClusterSummary sparks={sparks} temperatureUnit={temperatureUnit} />
  ) : null;
}
