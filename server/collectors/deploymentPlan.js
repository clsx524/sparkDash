import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../util/atomicWrite.js';
import { sshExec } from './ssh.js';
import { shQuotePath } from './modelSync.js';
import { llmProbeHost } from './llmHost.js';
import { isAllowedTargetHost } from '../validate.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = '~/.local/share/sparkdash-models';
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One draft, one committed placement, and the existing Apply executor. No scheduler. */
export class DeploymentPlanner {
  constructor(recipes, models, { file, services, execute = sshExec } = {}) {
    this.recipes = recipes;
    this.models = models;
    this.execute = execute;
    this.services = services ?? JSON.parse(fs.readFileSync(path.join(ROOT, '../config/services.json'), 'utf8'));
    this.images = JSON.parse(fs.readFileSync(path.join(ROOT, '../config/images.json'), 'utf8'));
    this.file = file ?? process.env.DEPLOYMENT_PLAN_JSON_PATH ?? path.join(path.dirname(process.env.MODELS_JSON_PATH || path.join(ROOT, '../../config/models.json')), 'deployment.json');
    this.state = { draft: this.defaults(), active: null };
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read deployment plan: ${error.message}`); }
  }

  defaults() {
    return { recipeId: 'deepseek-v41-lakyfx-tp3', placements: this.services.filter((service) => service.defaultHost).map((service) => ({ serviceId: service.id, sparkId: service.defaultHost })) };
  }

  catalog() {
    return {
      recipes: this.recipes.all().map(({ id, label, tp, requiredNodes, resources }) => ({ id, label, tp, requiredNodes, resources })),
      services: this.services.map(({ id, label, memoryGiB, startupGiB, diskGiB }) => ({ id, label, memoryGiB, startupGiB, diskGiB })),
      hosts: this.recipes.sparkRegistry.sparks.filter((host) => host.platform !== 'darwin' && host.platform !== 'windows' && host.modelFolder).map(({ id, name, modelFolder }) => ({ id, name, modelFolder })),
      draft: this.state.draft, active: this.state.active,
      reserveGiB: 12,
      budgetBasis: 'Conservative configuration budgets, including weights and image/build disk allowance, not measured peaks. Live memory admission is rechecked before each start.',
    };
  }

  compile(input) {
    if (!input || !Array.isArray(input.placements) || input.placements.length > 128) throw new Error('A plan requires a placements array');
    const base = input.recipeId == null ? null : this.recipes.get(input.recipeId);
    if (input.recipeId != null && !base) throw new Error('Unknown recipe');
    const target = base ? structuredClone(base) : { id: 'services-only', label: 'Standalone model services', tp: 1, nodes: [], requiredNodes: [] };
    const required = base ? this.recipes.resolveRequiredNodes(base) : [];
    const registryConfig = this.models.getRegistryConfig();
    for (const node of target.nodes) node.imageId = base.imageId || base.id;
    for (const node of target.nodes) {
      const host = this.recipes._sparkForNode(node);
      const modelRoot = host.id === registryConfig.hostId ? registryConfig.directory : host.modelFolder;
      if (!modelRoot) throw new Error('Configure the model registry and target model folder first');
      const prefix = `SPARKDASH_MODEL_ROOT=${shQuotePath(modelRoot)} `;
      if (node.prepareCmd) node.prepareCmd = prefix + node.prepareCmd;
      if (node.startCmd) node.startCmd = prefix + node.startCmd;
    }
    const seen = new Set();
    const placements = input.placements.map((placement) => {
      const service = this.services.find((item) => item.id === placement.serviceId);
      const host = this.recipes.sparkRegistry.getSpark(placement.sparkId);
      if (!service || !host || host.platform === 'darwin' || host.platform === 'windows' || !host.modelFolder) throw new Error('Unknown service or incompatible host');
      if (seen.has(service.id)) throw new Error(`Duplicate placement: ${service.id}`);
      seen.add(service.id);
      if (!required.some((item) => item.id === host.id)) required.push(host);
      const registry = this.models.getRegistryConfig();
      const modelRoot = host.id === registry.hostId ? registry.directory : host.modelFolder;
      if (!modelRoot) throw new Error('Configure the Atom model registry before applying');
      const cmd = `SPARKDASH_MODEL_ROOT=${shQuotePath(modelRoot)} python3 ${RUNTIME}/model-runtime.py`;
      target.nodes.push({ role: service.id, sparkId: host.id, serviceId: service.id, imageId: service.id, workdir: RUNTIME,
        prepareCmd: `${cmd} prepare ${service.id}`, startCmd: `${cmd} start ${service.id}`, stopCmd: `${cmd} stop ${service.id}`,
        statusCmd: `${cmd} status ${service.id}`, runningPattern: '^running$', containerName: service.id,
        llmPort: service.port, healthPath: service.healthPath, modelIds: service.modelIds,
        memoryGiB: service.memoryGiB, startupGiB: service.startupGiB, diskGiB: service.diskGiB, startOrder: 0 });
      return { serviceId: service.id, sparkId: host.id };
    }).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
    if (target.nodes.some((node) => node.modelIds?.length)) {
      const source = this.recipes.sparkRegistry.getSpark(registryConfig.hostId);
      if (!source) throw new Error('Configure the canonical model registry host before applying');
      if (!required.some((host) => host.id === source.id)) required.push(source);
    }
    if (!required.length) throw new Error('Select a recipe or at least one service');
    const resources = new Map(required.map((host) => [host.id, { memoryGiB: 0, startupExtraGiB: 0, diskGiB: 0, workloads: [] }]));
    if (base) {
      for (const host of this.recipes.resolveRequiredNodes(base)) {
        const budget = base.resources?.[host.id];
        if (!budget || !Number.isFinite(budget.memoryGiB) || !Number.isFinite(budget.diskGiB)) throw new Error(`Recipe ${base.id} needs an explicit resource budget for ${host.id}`);
        const resource = resources.get(host.id);
        resource.memoryGiB += budget.memoryGiB;
        resource.startupExtraGiB = Math.max(resource.startupExtraGiB, (budget.startupGiB ?? budget.memoryGiB) - budget.memoryGiB);
        resource.diskGiB += budget.diskGiB;
        resource.workloads.push(base.label);
      }
    }
    for (const node of target.nodes.filter((node) => node.serviceId)) {
      const resource = resources.get(node.sparkId);
      resource.memoryGiB += node.memoryGiB;
      resource.startupExtraGiB = Math.max(resource.startupExtraGiB, node.startupGiB - node.memoryGiB);
      resource.diskGiB += node.diskGiB;
      resource.workloads.push(node.serviceId);
    }
    const normalized = { recipeId: base?.id ?? null, placements };
    return { input: normalized, target, requiredNodes: required, resources,
      revision: hash({ input: normalized, target, services: this.services, images: this.images, registry: this.models.getRegistryConfig() }) };
  }

  async preview(input, { save = false, signal } = {}) {
    const plan = this.compile(input);
    const hosts = await Promise.all(plan.requiredNodes.map(async (host) => {
      const budget = plan.resources.get(host.id);
      const selected = plan.target.nodes.filter((node) => node.sparkId === host.id).flatMap((node) => node.modelIds || []);
      const registry = this.models.getRegistryConfig();
      const modelRoot = host.id === registry.hostId ? registry.directory : host.modelFolder;
      const folders = [...new Set(selected)].map((id) => this.models.getModel(id)?.subfolder).filter(Boolean);
      const otherCache = plan.input.recipeId === 'deepseek-v41-flash'
        ? ['.cache/huggingface/DeepSeek-V4.1-Flash-1017-EXL3-3.5bpw-TensorFold', '.cache/huggingface/sparkdash-tp3']
        : plan.input.recipeId === 'deepseek-v41-lakyfx-tp3'
          ? ['.cache/huggingface/tensorfold-dsv41/45ee5d0f', '.cache/huggingface/DeepSeek-V4.1-Flash-1017-EXL3-EAQ-v1-2.9-bpw', '.cache/huggingface/hub/models--Mia-AiLab--DeepSeek-V4.1-Flash-1017-EXL3-EAQ-v1-2.9-bpw', '.cache/huggingface/DeepSeek-V4.1-Flash-1017-Engram-1bae0e1', '.cache/huggingface/hub/models--deepseek-ai--DeepSeek-V4.1-Flash-1017', '.cache/dsv41-tensorfold/rank-cache-45ee5d0f', '.cache/dsv41-tensorfold/engram-1bae0e10'] : [];
      const otherModelFolders = otherCache.filter((folder) => folder.startsWith('.cache/huggingface/DeepSeek-')).map((folder) => path.posix.basename(folder));
      const probe = [
        'import json,os,pathlib,platform,subprocess',
        `r=pathlib.Path(os.path.expanduser(${JSON.stringify(modelRoot)}))`,
        'p=r',
        'while not p.exists(): p=p.parent',
        's=os.statvfs(p)',
        "m={line.split(':')[0]:int(line.split()[1])/1024**2 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:'))}",
        `folders=[r/f for f in ${JSON.stringify(host.id === registry.hostId ? [] : folders)} if (r/f).is_dir()]`,
        `if ${JSON.stringify(plan.input.recipeId || '')} == 'deepseek-v41-lakyfx-tp3' and (pathlib.Path.home()/'.cache/huggingface/sparkdash-tp3').is_dir(): folders.append(pathlib.Path.home()/'.cache/huggingface/sparkdash-tp3')`,
        'def allocated(items):',
        ' if not items: return 0',
        " return int(subprocess.check_output(['du','-scB1',*map(str,items)],text=True).splitlines()[-1].split()[0])/2**30",
        `evict=[pathlib.Path.home()/f for f in ${JSON.stringify(host.id === registry.hostId ? [] : otherCache)} if (pathlib.Path.home()/f).is_dir()]`,
        `evict.extend(r/f for f in ${JSON.stringify(host.id === registry.hostId ? [] : otherModelFolders)} if (r/f).is_dir())`,
        "print(json.dumps(dict(totalGiB=m['MemTotal'],availableGiB=m['MemAvailable'],diskFreeGiB=s.f_bavail*s.f_frsize/2**30,stagedGiB=allocated(folders),evictableGiB=allocated(evict),machine=platform.machine())))",
      ].join('\n');
      try {
        const measured = JSON.parse(await this.execute(host, `python3 -c ${quote(probe)}`, { timeoutMs: 20_000, cancelRemote: true, signal }));
        if (![measured.totalGiB, measured.availableGiB, measured.diskFreeGiB, measured.stagedGiB, measured.evictableGiB].every(Number.isFinite)) throw new Error('Invalid host resource measurement');
        const neededGiB = budget.memoryGiB + budget.startupExtraGiB + 12;
        const additionalDiskGiB = Math.max(0, budget.diskGiB - measured.stagedGiB);
        const errors = [];
        if (!['aarch64', 'arm64'].includes(measured.machine)) errors.push('The supplied runtime images require ARM64');
        if (neededGiB > measured.totalGiB) errors.push(`Needs ${neededGiB.toFixed(1)} GiB including startup and reserve; host has ${measured.totalGiB.toFixed(1)}`);
        if (additionalDiskGiB + 10 > measured.diskFreeGiB + measured.evictableGiB) errors.push(`Needs ${additionalDiskGiB.toFixed(1)} GiB additional disk plus 10 GiB reserve after planned cache eviction`);
        return { id: host.id, name: host.name || host.id, ...budget, ...measured, neededGiB, additionalDiskGiB, errors };
      } catch (error) {
        return { id: host.id, name: host.name || host.id, ...budget, errors: [`Cannot measure host: ${error.message}`] };
      }
    }));
    signal?.throwIfAborted();
    const errors = hosts.flatMap((host) => host.errors.map((error) => `${host.name}: ${error}`));
    for (const node of plan.target.nodes) for (const id of node.modelIds || []) if (!this.models.getModel(id)) errors.push(`Register model ${id} before applying`);
    const steps = [
      'Verify that all selected runtime images were prepared on Atom and their RDMA sources are available',
      'Stop conflicting model containers only; unrelated containers and host NFS remain untouched',
      ...(plan.input.recipeId?.startsWith('deepseek-') ? ['Evict the other DeepSeek deployment cache on Spark1/2 only; preserve Atom registry weights'] : []),
      'Import the selected prepared images through NFS/RDMA and stage the selected weights; no worker image builds or pulls',
      'Start and warm the selected small services, one at a time',
      ...(plan.input.recipeId ? ['Recheck live memory on every rank; start the selected large model and wait for serving readiness'] : []),
      'Commit the plan and switch stable inference routes to healthy placements',
    ];
    if (save) { this.state.draft = plan.input; this.save(); }
    return { input: plan.input, revision: plan.revision, valid: errors.length === 0, errors, hosts, steps };
  }

  save() { atomicWrite(this.file, JSON.stringify(this.state, null, 2) + '\n', 0o600); }
  commit(plan) { this.state.active = plan.input; this.state.draft = plan.input; this.save(); }

  register(app, startApply) {
    app.get('/api/deployment', (_req, res) => res.json(this.catalog()));
    app.post('/api/deployment/preview', async (req, res) => {
      try { res.json(await this.preview(req.body, { save: true })); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
    app.post('/api/deployment/apply', async (req, res) => {
      try {
        const input = structuredClone(this.state.draft);
        const preview = await this.preview(input);
        if (preview.revision !== req.body?.revision || hash(input) !== hash(this.state.draft)) return res.status(409).json({ error: 'Plan changed; build it again before Apply' });
        if (!preview.valid) return res.status(409).json({ error: preview.errors.join('; ') });
        const plan = this.compile(input);
        if (plan.revision !== preview.revision) return res.status(409).json({ error: 'Model definitions changed; build the plan again' });
        res.json(await startApply(plan.input.recipeId, plan));
      } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    });
    const routes = { embeddings: 'qwen3-embedding', tts: 'qwen3-tts', asr: 'qwen3-asr', images: 'qwen-image' };
    app.use('/inference/:service', (req, res) => {
      const serviceId = routes[req.params.service];
      const placement = this.state.active?.placements.find((item) => item.serviceId === serviceId);
      const service = this.services.find((item) => item.id === serviceId);
      const spark = placement && this.recipes.sparkRegistry.getSpark(placement.sparkId);
      if (!service || !spark) return res.status(503).json({ error: 'No applied placement for this model service' });
      const host = llmProbeHost(spark);
      if (!isAllowedTargetHost(host)) return res.status(503).json({ error: 'Invalid model host' });
      const headers = { ...req.headers, host: `${host}:${service.port}` };
      delete headers.authorization;
      const body = req.body === undefined ? null : Buffer.from(JSON.stringify(req.body));
      if (body) { headers['content-length'] = String(body.length); delete headers['transfer-encoding']; }
      const upstream = http.request({ hostname: host, port: service.port, path: req.url, method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('error', (error) => { if (!res.headersSent) res.status(503).json({ error: `Model upstream unavailable: ${error.message}` }); else res.destroy(); });
      upstream.setTimeout(300_000, () => upstream.destroy(new Error('Model request timed out')));
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      if (body) upstream.end(body); else req.pipe(upstream);
    });
  }
}
