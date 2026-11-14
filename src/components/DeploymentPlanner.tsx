import { useEffect, useRef, useState } from 'react';
import { buildDeploymentPlan, fetchDeploymentCatalog } from '../api/client';
import type { DeploymentCatalog, DeploymentInput, DeploymentPreview } from '../api/deploymentTypes';

interface Props {
  disabled: boolean;
  applying: boolean;
  onApply: (revision: string) => Promise<void>;
  onPrepareImages: () => Promise<void>;
}

export function DeploymentPlanner({ disabled, applying, onApply, onPrepareImages }: Props) {
  const [catalog, setCatalog] = useState<DeploymentCatalog | null>(null);
  const [input, setInput] = useState<DeploymentInput | null>(null);
  const [preview, setPreview] = useState<DeploymentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const epoch = useRef(0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchDeploymentCatalog().then((value) => {
      if (active) { setCatalog(value); setInput(value.draft); setError(null); }
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; ++epoch.current; };
  }, [reload]);

  function change(value: DeploymentInput) {
    ++epoch.current;
    setBuilding(false);
    setInput(value);
    setPreview(null);
  }
  function place(serviceId: string, sparkId: string) {
    if (!input || disabled || !catalog?.services.some((service) => service.id === serviceId)) return;
    const placements = input.placements.filter((placement) => placement.serviceId !== serviceId);
    if (sparkId) placements.push({ serviceId, sparkId });
    change({ ...input, placements });
  }
  async function build() {
    if (!input) return;
    const generation = ++epoch.current;
    setBuilding(true);
    setError(null);
    try {
      const result = await buildDeploymentPlan(input);
      if (epoch.current === generation) setPreview(result);
    } catch (cause) {
      if (epoch.current === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === generation) setBuilding(false);
    }
  }
  function card(service: DeploymentCatalog['services'][number]) {
    const host = input?.placements.find((placement) => placement.serviceId === service.id)?.sparkId || '';
    return <article key={service.id} draggable={!disabled}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', service.id); event.dataTransfer.effectAllowed = 'move'; }}
      className="rounded border border-border bg-surface-elevated p-3">
      <h4 className="text-xs font-semibold text-text-strong">{service.label}</h4>
      <p className="my-1 text-[10px] text-muted">{service.memoryGiB} GiB runtime estimate · {service.startupGiB} GiB startup estimate</p>
      <label className="block text-[10px] text-muted">Placement
        <select aria-label={`${service.label} placement`} value={host} disabled={disabled}
          onChange={(event) => place(service.id, event.target.value)}
          className="mt-1 w-full rounded border border-border bg-surface p-1.5 text-xs text-text-strong">
          <option value="">Not deployed</option>
          {catalog?.hosts.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
        </select>
      </label>
    </article>;
  }
  function drop(sparkId: string): React.DragEventHandler<HTMLElement> {
    return (event) => { event.preventDefault(); place(event.dataTransfer.getData('text/plain'), sparkId); };
  }
  const recipe = catalog?.recipes.find((item) => item.id === input?.recipeId);
  return <section aria-label="Deployment topology planner" className="mt-4 space-y-3 border-t border-border pt-4">
    <h3 className="text-sm font-semibold text-text-strong">Deployment topology planner</h3>
    <p className="text-[10px] text-muted">Prepare all recipe and service images once on Atom, independently of placement. Apply imports only the selected images and stages their required weights over RDMA.</p>
    <button type="button" disabled={disabled} onClick={() => { void onPrepareImages(); }}
      className="rounded border border-border bg-surface-elevated px-3 py-2 text-xs font-medium text-text-strong disabled:opacity-50">Prepare all images on Atom</button>
    {error && <p role="alert" className="text-xs text-danger">{error} <button type="button" className="underline" onClick={() => setReload((value) => value + 1)}>Reload planner</button></p>}
    {!catalog || !input ? <p className="text-xs text-muted">Loading model definitions and saved placement…</p> : <>
      <label className="block text-xs text-muted">Large model recipe
        <select aria-label="Large model recipe" value={input.recipeId || ''} disabled={disabled}
          onChange={(event) => change({ ...input, recipeId: event.target.value || null })}
          className="ml-2 max-w-full rounded border border-border bg-surface p-2 text-xs text-text-strong">
          <option value="">Small services only</option>
          {catalog.recipes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <p className="text-[10px] text-muted">Drag service cards between hosts, or use their placement selectors. Distributed ranks follow the selected recipe’s wired topology. Only selected models are staged.</p>
      <div className="grid gap-3 md:grid-cols-3">
        {catalog.hosts.map((host) => {
          const capacity = preview?.hosts.find((item) => item.id === host.id);
          const rank = recipe?.requiredNodes.findIndex((node) => 'sparkId' in node && node.sparkId === host.id) ?? -1;
          return <section key={host.id} aria-label={`${host.name || host.id} placement`} onDragOver={(event) => event.preventDefault()} onDrop={drop(host.id)}
            className="min-h-40 space-y-2 rounded border border-border bg-surface p-3">
            <h4 className="text-xs font-semibold text-text-strong">{host.name || host.id}</h4>
            {capacity && <p className={`text-[10px] ${capacity.errors.length ? 'text-danger' : 'text-muted'}`}>
              {capacity.neededGiB?.toFixed(1) ?? '?'} / {capacity.totalGiB?.toFixed(1) ?? '?'} GiB estimated; not enforced<br />
              +{capacity.additionalDiskGiB?.toFixed(1) ?? '?'} GiB disk / {capacity.diskFreeGiB?.toFixed(1) ?? '?'} GiB free
            </p>}
            {rank >= 0 && <div className="rounded border border-accent bg-accent-soft p-2 text-[10px] text-accent">{recipe?.label}<br />Fixed compute member {rank + 1} / {recipe?.tp}</div>}
            {catalog.services.filter((service) => input.placements.some((placement) => placement.serviceId === service.id && placement.sparkId === host.id)).map(card)}
          </section>;
        })}
      </div>
      <section aria-label="Not deployed models" onDragOver={(event) => event.preventDefault()} onDrop={drop('')}
        className="rounded border border-dashed border-border p-3">
        <h4 className="mb-2 text-xs font-semibold text-muted">Not deployed</h4>
        <div className="grid gap-2 md:grid-cols-2">{catalog.services.filter((service) => !input.placements.some((placement) => placement.serviceId === service.id)).map(card)}</div>
      </section>
      <p className="text-[10px] text-muted">{catalog.budgetBasis}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={disabled || building} onClick={() => { void build(); }}
          className="rounded border border-border bg-surface-elevated px-3 py-2 text-xs font-medium text-text-strong disabled:opacity-50">{building ? 'Checking hosts…' : 'Build plan'}</button>
        <button type="button" disabled={disabled || building || !preview?.valid} onClick={() => { if (preview) void onApply(preview.revision); }}
          className="rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{applying ? 'Applying…' : 'Apply plan'}</button>
      </div>
      {preview && <section aria-label="Plan preview" className="rounded border border-border p-3 text-xs">
        <h4 className={preview.valid ? 'text-accent' : 'text-danger'}>{preview.valid ? 'Plan ready; memory estimates are not enforced' : 'Plan blocked'}</h4>
        {preview.errors.length > 0 && <ul role="alert" className="my-2 list-disc pl-4 text-danger">{preview.errors.map((message) => <li key={message}>{message}</li>)}</ul>}
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted">{preview.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      </section>}
    </>}
  </section>;
}
