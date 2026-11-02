import type { RecipeRequiredNode } from './types';

export interface DeploymentInput {
  recipeId: string | null;
  placements: Array<{ serviceId: string; sparkId: string }>;
}
export interface DeploymentCatalog {
  recipes: Array<{ id: string; label: string; tp: number; requiredNodes: RecipeRequiredNode[] }>;
  services: Array<{ id: string; label: string; memoryGiB: number; startupGiB: number; diskGiB: number }>;
  hosts: Array<{ id: string; name: string; modelFolder: string }>;
  draft: DeploymentInput;
  active: DeploymentInput | null;
  reserveGiB: number;
  budgetBasis: string;
}
export interface DeploymentPreview {
  input: DeploymentInput;
  revision: string;
  valid: boolean;
  errors: string[];
  hosts: Array<{ id: string; name: string; memoryGiB: number; totalGiB?: number; availableGiB?: number; neededGiB?: number; additionalDiskGiB?: number; diskFreeGiB?: number; errors: string[] }>;
  steps: string[];
}
