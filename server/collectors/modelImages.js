import { sshExec } from './ssh.js';
import { nfsSourceDirectory, shQuotePath } from './modelSync.js';
import { settleAll } from '../util/abort.js';

const COMMAND = 'python3 ~/.local/share/sparkdash-models/model_images.py';
const TIMEOUT = 6 * 60 * 60_000;
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

function registrySource(models) {
  const config = models?.getRegistryConfig();
  const host = models?.registryHost();
  if (!host || !config.directory) throw new Error('Configure Atom as the canonical Model Registry before preparing images');
  return { config, host };
}

function commandOptions(host, options) {
  return { timeoutMs: options.preflightOnly ? 60_000 : TIMEOUT, signal: options.signal, cancelRemote: true,
    onOutput: (line) => options.onLog?.({ ...line, nodeId: host.id, nodeName: host.name || host.id }) };
}

/** Independent of placements: build/pull and publish every declared image on Atom. */
export async function prepareAllImages(models, options = {}) {
  const { config, host } = registrySource(models);
  await sshExec(host, `${COMMAND} build-all --registry ${shQuotePath(config.directory)}`, commandOptions(host, options));
}

/** Apply never builds or pulls images. Workers read archives through verified NFS/RDMA. */
export async function stageRecipeImages(recipes, models, recipe, options = {}) {
  const groups = new Map();
  for (const node of recipe.nodes.filter((item) => item.imageId)) {
    const host = recipes._sparkForNode(node);
    if (!host) throw new Error(`No host configured for ${node.role}`);
    if (!groups.has(host.id)) groups.set(host.id, { host, images: new Set() });
    groups.get(host.id).images.add(node.imageId);
  }
  if (!groups.size) return;
  const { config, host: source } = registrySource(models);
  const ids = [...new Set([...groups.values()].flatMap((group) => [...group.images]))];
  if (options.preflightOnly) {
    await sshExec(source, `${COMMAND} check ${ids.map(quote).join(' ')} --registry ${shQuotePath(config.directory)}`, commandOptions(source, options));
  }
  await settleAll([...groups.values()].map(async ({ host, images }) => {
    options.signal?.throwIfAborted();
    let directory = config.directory;
    if (host.id !== source.id) {
      const mount = config.nfsMounts?.[host.id];
      if (!mount || mount.transport !== 'rdma') throw new Error(`${host.name || host.id}: configure the Atom read-only NFS/RDMA image source; no SSH image fallback`);
      await nfsSourceDirectory(host, mount, '.sparkdash-images', { ...commandOptions(host, options), timeoutMs: 15_000 });
      directory = mount.path;
    }
    if (options.preflightOnly && host.id === source.id) return;
    if (!options.preflightOnly) options.onLog?.({ stream: 'action', nodeId: host.id, nodeName: host.name || host.id,
      text: 'Importing prepared images from Atom; exact cached images are reused, no builds or pulls' });
    const action = options.preflightOnly ? 'check' : 'import';
    await sshExec(host, `${COMMAND} ${action} ${[...images].map(quote).join(' ')} --registry ${shQuotePath(directory)}`, commandOptions(host, options));
  }));
}
