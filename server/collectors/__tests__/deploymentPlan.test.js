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
    resources: Object.fromEntries(sparks.map((spark) => [spark.id, { memoryGiB: 90, diskGiB: 150 }])),
    nodes: [{ role: 'head', sparkId: 'one', modelIds: [] }] }];
  const services = [{ id: 'qwen3-asr', label: 'ASR', port: 8892, healthPath: '/v1/models', memoryGiB: 8, startupGiB: 10, diskGiB: 4, modelIds: ['asr'] }];
  const measurements = new Map(sparks.map((spark) => [spark.id, { totalGiB: 112, availableGiB: 105, diskFreeGiB: 400, stagedGiB: 0, evictableGiB: 0, machine: 'aarch64' }]));
  let probes = 0;
  const models = { getRegistryConfig: () => ({ hostId: 'atom', directory: '/registry' }), getModel: (id) => ({ id, subfolder: id }) };
  const planner = new DeploymentPlanner(registry, models, { file: path.join(directory, 'plan.json'), services,
    execute: async (spark) => { probes++; return JSON.stringify(measurements.get(spark.id)); } });
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
  measurements.get('one').diskFreeGiB = 160;
  assert.match((await planner.preview(input)).errors.join(';'), /additional disk/);
  measurements.get('one').diskFreeGiB = 164;
  assert.equal((await planner.preview(input)).valid, true);
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

test('stable inference route streams binary uploads and follows only committed placements', async (t) => {
  const { planner, services } = fixture(t);
  const received = [];
  const upstream = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, body: Buffer.concat(chunks) });
    response.setHeader('content-type', 'application/octet-stream');
    response.write(Buffer.from([0, 255, 1]));
    response.end(Buffer.from([2, 0, 254]));
  });
  services[0].port = Number(new URL(upstream).port);
  const app = express();
  planner.register(app, () => { throw new Error('Not an Apply test'); });
  const front = await listen(t, app);
  const bytes = Buffer.from([1, 0, 255, 128, 2]);
  const send = () => fetch(front + '/inference/asr/v1/audio/transcriptions?format=json', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=sample' }, body: bytes });
  assert.equal((await send()).status, 503);
  await planner.preview({ recipeId: null, placements: [{ serviceId: 'qwen3-asr', sparkId: 'one' }] }, { save: true });
  assert.equal((await send()).status, 503); // Building a draft never changes serving routes.
  planner.commit(planner.compile(planner.state.draft));
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 1, 2, 0, 254]));
  assert.equal(received[0].path, '/v1/audio/transcriptions?format=json');
  assert.deepEqual(received[0].body, bytes);
});
