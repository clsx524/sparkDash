import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { RecipeRegistry } from '../RecipeRegistry.js';
import { DeploymentPlanner } from '../deploymentPlan.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sparks = ['one', 'two', 'atom'].map((id) => ({ id, name: id, modelFolder: '/models', lanIp: '127.0.0.1', ssh: { host: '127.0.0.1', user: 'test' } }));
  const registry = new RecipeRegistry({ sparks, getSpark: (id) => sparks.find((spark) => spark.id === id) });
  registry._recipes = [{ id: 'distributed', label: 'Distributed', tp: 3,
    requiredNodes: sparks.map((spark) => ({ sparkId: spark.id })),
    resources: Object.fromEntries(sparks.map((spark) => [spark.id, { memoryGiB: 90, runtimeDiskGiB: 10 }])),
    nodes: [{ role: 'head', sparkId: 'one', modelIds: [], llmPort: 8888, healthPath: '/v1/models' }] }];
  const services = [{ id: 'qwen3-asr', label: 'ASR', port: 8892, healthPath: '/v1/models', memoryGiB: 8, startupGiB: 10, modelIds: ['asr'] }];
  const GiB = 2 ** 30;
  const measurements = new Map(sparks.map((spark) => [spark.id, {
    totalGiB: 112, availableGiB: 105, machine: 'aarch64',
    volumes: [{ paths: { models: '/models' }, freeBytes: 400 * GiB, evictableBytes: 0, runtimeBytes: 10 * GiB }],
  }]));
  let probes = 0;
  const models = { getRegistryConfig: () => ({ hostId: 'atom', directory: '/registry' }), getModel: (id) => ({ id, subfolder: id }) };
  const planner = new DeploymentPlanner(registry, models, { file: path.join(directory, 'plan.json'), services,
    execute: async (spark, command) => {
      probes++;
      if (command.includes("' inventory '")) {
        return JSON.stringify({ models: { asr: [{ path: 'model.safetensors', size: GiB, mtime: 1 }] },
          images: { distributed: { bytes: 11 * GiB }, 'qwen3-asr': { bytes: 22 * GiB } } });
      }
      if (!measurements.has(spark.id)) throw new Error('host unavailable');
      return JSON.stringify(measurements.get(spark.id));
    } });
  return { planner, registry, measurements, services, probes: () => probes, file: path.join(directory, 'plan.json') };
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('memory estimates do not block deployment; disk capacity and measurement failures still do', async (t) => {
  const { planner, measurements } = fixture(t);
  const input = { recipeId: 'distributed', placements: [{ serviceId: 'qwen3-asr', sparkId: 'one' }] };
  measurements.get('one').totalGiB = 16;
  measurements.get('one').availableGiB = 0.1;
  assert.equal((await planner.preview(input)).valid, true);
  const [disk] = measurements.get('one').volumes;
  disk.freeBytes = 19 * 2 ** 30;
  assert.match((await planner.preview(input)).errors.join(';'), /10.0 GiB additional disk.*0.0 weights, 0.0 images, 10.0 runtime/);
  disk.freeBytes = 20 * 2 ** 30;
  assert.equal((await planner.preview(input)).valid, true);
  measurements.get('one').volumes.push({
    paths: { images: '/var/lib/docker' }, freeBytes: 20 * 2 ** 30, evictableBytes: 0, imageBytes: 11 * 2 ** 30,
  });
  assert.match((await planner.preview(input)).errors.join(';'), /10 GiB reserve on \/var\/lib\/docker/);
  measurements.delete('one');
  assert.match((await planner.preview(input)).errors.join(';'), /Cannot measure host/);
});

test('duplicate service placement and unknown hosts are rejected before probing; one committed placement survives reload', async (t) => {
  const { planner, registry, probes, file, services } = fixture(t);
  assert.throws(() => planner.compile({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'missing' }] }), /incompatible host/);
  assert.throws(() => planner.compile({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'one' }, { serviceId: 'qwen3-asr', sparkId: 'two' }] }), /Duplicate placement/);
  assert.equal(probes(), 0);
  const plan = planner.compile({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'two' }] });
  planner.commit(plan);
  const restored = new DeploymentPlanner(registry, planner.models, { file, services });
  assert.deepEqual(restored.state.active, plan.input);
});

test('Apply rejects stale preview revisions without starting a deployment', async (t) => {
  const { planner } = fixture(t);
  const app = express(); app.use(express.json());
  let started = 0;
  planner.register(app, async () => { started++; return { started: true }; });
  const base = await listen(t, app);
  const first = await planner.preview({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'one' }] }, { save: true });
  await planner.preview({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'two' }] }, { save: true });
  const response = await fetch(base + '/api/deployment/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: first.revision }) });
  assert.equal(response.status, 409);
  assert.equal(started, 0);
});

test('Drama is optional and restricted to Atom', async (t) => {
  const { planner, registry, file, probes } = fixture(t);
  const liveCatalog = new DeploymentPlanner(registry, planner.models, { file });
  const catalog = liveCatalog.catalog();
  assert.equal(catalog.draft.placements.some(({ serviceId }) => serviceId === 'drama-tts'), false);
  assert.equal(catalog.services.find(({ id }) => id === 'drama-tts')?.onlyHost, 'atom');
  const draft = (sparkId) => ({ recipeId: null, placements: [{ serviceId: 'drama-tts', sparkId }] });
  assert.throws(() => liveCatalog.compile(draft('one')), /only be deployed on Atom/);
  assert.equal(probes(), 0);
  const plan = liveCatalog.compile(draft('atom'));
  assert.deepEqual(plan.target.nodes.map(({ imageId, modelIds }) => ({ imageId, modelIds })), [
    { imageId: 'drama-tts', modelIds: ['drama-3'] },
  ]);
});

async function registered(t, planner) {
  const app = express();
  app.use(express.json());
  planner.register(app, () => { throw new Error('Not an Apply test'); });
  return listen(t, app);
}

const commitDistributed = (planner, sparkId) =>
  planner.commit(planner.compile({ recipeId: 'distributed', placements: [{ serviceId: 'qwen3-asr', sparkId }] }));

test('active placements are empty until a plan is committed', async (t) => {
  const { planner } = fixture(t);
  const base = await registered(t, planner);
  const response = await fetch(base + '/api/deployment/active');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: null, recipe: null, services: [] });
});

test('active placements follow the committed recipe and service hosts', async (t) => {
  const { planner } = fixture(t);
  const base = await registered(t, planner);
  commitDistributed(planner, 'one');
  const first = await (await fetch(base + '/api/deployment/active')).json();
  assert.equal(typeof first.revision, 'string');
  assert.deepEqual(first.recipe, {
    id: 'distributed', label: 'Distributed', modelIds: [], host: '127.0.0.1', port: 8888, healthPath: '/v1/models',
  });
  assert.deepEqual(first.services, [
    { id: 'qwen3-asr', modelIds: ['asr'], host: '127.0.0.1', port: 8892, healthPath: '/v1/models' },
  ]);

  planner.recipes.sparkRegistry.getSpark('two').lanIp = '192.0.2.2';
  commitDistributed(planner, 'two');
  const second = await (await fetch(base + '/api/deployment/active')).json();
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.services[0].id, 'qwen3-asr');
  assert.equal(second.services[0].host, '192.0.2.2');
});

test('draft previews never change active placements', async (t) => {
  const { planner } = fixture(t);
  const base = await registered(t, planner);
  await planner.preview({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'one' }] }, { save: true });
  assert.deepEqual(await (await fetch(base + '/api/deployment/active')).json(), { revision: null, recipe: null, services: [] });
  commitDistributed(planner, 'one');
  const first = await (await fetch(base + '/api/deployment/active')).json();
  await planner.preview({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'two' }] }, { save: true });
  assert.deepEqual(await (await fetch(base + '/api/deployment/active')).json(), first);
});

test('llmHost takes precedence over lanIp for recipe and service hosts', async (t) => {
  const { planner } = fixture(t);
  const base = await registered(t, planner);
  commitDistributed(planner, 'one');
  planner.recipes.sparkRegistry.getSpark('one').llmHost = ' 10.0.0.9 ';
  const body = await (await fetch(base + '/api/deployment/active')).json();
  assert.equal(body.recipe.host, '10.0.0.9');
  assert.equal(body.services[0].host, '10.0.0.9');
});

test('matching If-None-Match returns 304', async (t) => {
  const { planner } = fixture(t);
  const base = await registered(t, planner);
  commitDistributed(planner, 'one');
  const first = await fetch(base + '/api/deployment/active');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await fetch(base + '/api/deployment/active', { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), '');
});

