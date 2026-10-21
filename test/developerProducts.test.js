import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildIdTree,
  loadCatalog,
  normalizeCatalog,
  syncDeveloperProducts,
} from '../src/shared/developerProducts.js';

test('buildIdTree produces Lua-shaped tables (1-based paths, empty slot 6)', () => {
  const tree = buildIdTree({
    Starter: 11,
    'Random-6x31': 12,
    'RoPowers.1.1': 21,
    'RoPowers.1.2': 22,
    'RoPowers.5.1': 25,
    'RoPowers.7.1': 27,
    'QuestRerolls.x1': 31,
  });
  assert.equal(tree.Starter, 11);
  assert.equal(tree['Random-6x31'], 12);
  assert.deepEqual(tree.RoPowers, [[21, 22], [], [], [], [25], [], [27]]);
  assert.deepEqual(tree.QuestRerolls, { x1: 31 });
});

test('shipped catalog contains valid, unique fixed-reward products only', () => {
  const { entries, defaultedPaths } = normalizeCatalog(loadCatalog({}), { defaultPrice: 100 });
  assert.equal(entries.length, 61);
  assert.ok(entries.every((e) => e.price >= 1 && e.name.length <= 50));
  assert.ok(!defaultedPaths.includes('QuestRerolls.x10'));
  assert.equal(defaultedPaths.length, 0);
  assert.equal(entries.find((e) => e.path === 'ShadowMewtwo').price, 500);
  assert.equal(entries.find((e) => e.path === 'QuestRerolls.x10').price, 135);
  assert.ok(entries.find((e) => e.path === 'GoldBottleCap' && e.price === 1500));
  assert.ok(!entries.some((e) => e.path.startsWith('RoPowers.6')));
  assert.ok(!entries.some((e) => /Roulette|Lotto|Random-Shiny|Random-6x31|^PBSpins/.test(e.path)));
  assert.throws(() => normalizeCatalog([{ path: 'BasicRoulette', name: 'Basic Roulette', price: 10 }]), /excluded from automatic creation/);
  assert.throws(() => normalizeCatalog([{ path: 'RouletteSpinBasic', name: 'Roulette Spin Basic', price: 10 }]), /excluded from automatic creation/);
});


test('root productids.json is a non-live template with sequential placeholders 1..61', () => {
  const template = JSON.parse(fs.readFileSync(new URL('../productids.json', import.meta.url), 'utf8'));
  assert.equal(template._template, true);
  assert.equal(template.universeId, 0);
  const values = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    } else {
      values.push(node);
    }
  };
  visit(template.productids);
  assert.equal(values.length, 61);
  assert.deepEqual(values, Array.from({ length: 61 }, (_, i) => i + 1));
});

test('normalizeCatalog rejects duplicates and bad prices', () => {
  assert.throws(() => normalizeCatalog([{ path: 'A', name: 'X', price: 5 }, { path: 'B', name: 'x', price: 5 }]), /duplicate product name/);
  assert.throws(() => normalizeCatalog([{ path: 'A', price: 0 }]), /price/);
  assert.throws(() => normalizeCatalog([{ path: 'bad path', price: 5 }]), /invalid path/);
});

function fakeRoblox({ applyWrites = true } = {}) {
  const products = [];
  let nextId = 5000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST') {
      const form = init.body;
      const id = nextId++;
      if (applyWrites) products.push({ productId: id, name: form.get('name'), price: Number(form.get('price')) });
      return new Response(JSON.stringify({ productId: id, name: form.get('name') }), { status: 200 });
    }
    return new Response(JSON.stringify({ developerProducts: products, nextPageToken: '' }), { status: 200 });
  };
  return { products, restore: () => { globalThis.fetch = realFetch; } };
}

test('syncDeveloperProducts creates, then reuses on re-run, and writes productids.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const out = path.join(dir, 'productids.json');
  const fake = fakeRoblox();
  const config = {
    developerProducts: {
      outputPath: out,
      required: false,
      catalog: [
        { path: 'Starter', name: 'Starter', price: 15 },
        { path: 'RoPowers.1.1', name: 'Ro Power: XP 1', price: 15 },
        { path: 'RoPowers.2.1', name: 'Ro Power: Hatch 1', price: 10 },
        { path: 'QuestRerolls.x1', name: 'Quest Rerolls x1', price: 15 },
      ],
    },
    placeIds: { git: { enabled: false } },
  };
  try {
    const first = await syncDeveloperProducts(config, 123, { apiKey: 'k' });
    assert.equal(first.created, 4);
    assert.equal(first.reused, 0);
    const file = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(file.universeId, 123);
    assert.equal(file.productids.Starter, 5000);
    assert.deepEqual(file.productids.RoPowers, [[5001], [5002]]);
    assert.equal(file.productids.QuestRerolls.x1, 5003);

    const second = await syncDeveloperProducts(config, 123, { apiKey: 'k' });
    assert.equal(second.created, 0);
    assert.equal(second.reused, 4);
    assert.equal(fake.products.length, 4);
  } finally {
    fake.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncDeveloperProducts refuses to publish when writes were silently not applied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const out = path.join(dir, 'productids.json');
  const fake = fakeRoblox({ applyWrites: false });
  try {
    await assert.rejects(
      () => syncDeveloperProducts({
        developerProducts: { outputPath: out, catalog: [{ path: 'Starter', name: 'Starter', price: 5 }] },
        placeIds: { git: { enabled: false } },
      }, 1, { apiKey: 'k' }),
      /developer-product:write/
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    fake.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
