'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const TEST_DB = process.env.TEST_DATABASE_URL;
const ROOT = path.resolve(__dirname, '..');
const skip = TEST_DB ? false : 'ไม่ได้ตั้ง TEST_DATABASE_URL';

if (TEST_DB) {
  const u = new URL(TEST_DB);
  const dbName = u.pathname.slice(1);
  assert.match(dbName, /^[a-z0-9_]*test[a-z0-9_]*$/, 'TEST_DATABASE_URL ต้องชี้ DB ที่ชื่อมีคำว่า test');
}

test('import-hero-skus: idempotent import, exactly 7 products, verified prices & costs', { skip }, async () => {
  const scriptPath = path.join(ROOT, 'scripts', 'import-hero-skus.js');
  const ownerEmail = 'import-test@example.com';

  const runImport = (extraArgs = []) => {
    return spawnSync(process.execPath, [scriptPath, ...extraArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB,
        OWNER_EMAIL: ownerEmail,
      },
      encoding: 'utf8',
    });
  };

  // 1. Dry run should exit 0 and not fail
  const dry = runImport(['--dry-run']);
  assert.equal(dry.status, 0, `Dry run failed: ${dry.stderr}`);
  assert.match(dry.stdout, /\[DRY RUN\]/);

  // 2. First import run
  const res1 = runImport();
  assert.equal(res1.status, 0, `First import failed: ${res1.stderr}`);

  // 3. Second import run (idempotency check)
  const res2 = runImport();
  assert.equal(res2.status, 0, `Second import failed: ${res2.stderr}`);

  // 4. Verify in PostgreSQL
  const pg = new Client({ connectionString: TEST_DB });
  await pg.connect();
  try {
    const { rows: users } = await pg.query('SELECT id, email, is_demo FROM users WHERE email = $1', [ownerEmail]);
    assert.equal(users.length, 1, 'expected exactly one user for owner email');
    assert.equal(users[0].is_demo, false);
    const userId = users[0].id;

    const { rows: shops } = await pg.query('SELECT id, name FROM shops WHERE owner_user_id = $1', [userId]);
    assert.equal(shops.length, 1, 'expected exactly one shop for owner');
    const shop = shops[0];
    assert.equal(shop.name, 'Sea farmer (by Daiseiko)');

    const { rows: members } = await pg.query('SELECT role FROM shop_members WHERE shop_id = $1 AND user_id = $2', [shop.id, userId]);
    assert.equal(members.length, 1);
    assert.equal(members[0].role, 'OWNER');

    const { rows: heroProducts } = await pg.query(
      `SELECT p.id, p.code, p.name, p.cost_base_satang, p.stock_base, p.min_stock_base, b.price_satang, b.barcode
       FROM products p
       JOIN barcodes b ON b.product_id = p.id
       WHERE p.shop_id = $1 AND p.code LIKE 'SF-HERO-%'
       ORDER BY p.code ASC`,
      [shop.id]
    );

    // Assert exactly 7 SF-HERO products
    assert.equal(heroProducts.length, 7, 'assert exactly 7 SF-HERO products in shop');

    // SF-HERO-01: Snow Fish (32000 / 13750 satang)
    const snowFish = heroProducts.find((p) => p.code === 'SF-HERO-01');
    assert.ok(snowFish, 'SF-HERO-01 not found');
    assert.equal(snowFish.name, 'Snow Fish Kirimi 100g');
    assert.equal(snowFish.price_satang, '32000');
    assert.equal(snowFish.cost_base_satang, '13750');
    assert.equal(Number(snowFish.min_stock_base), 5);
    assert.ok(snowFish.barcode.startsWith('2008852001'));

    // SF-HERO-06: Kani Miso (18900 price, cost 6400+2100=8500)
    const kaniMiso = heroProducts.find((p) => p.code === 'SF-HERO-06');
    assert.ok(kaniMiso, 'SF-HERO-06 not found');
    assert.equal(kaniMiso.name, 'Kani Miso 60g + Crab Shell');
    assert.equal(kaniMiso.price_satang, '18900');
    assert.equal(kaniMiso.cost_base_satang, '8500');
    assert.ok(kaniMiso.barcode.startsWith('2008852006'));

    // Verify all 7 barcodes have valid 13-digit format starting with 2008852
    for (const p of heroProducts) {
      assert.match(p.barcode, /^2008852\d{6}$/);
    }
  } finally {
    await pg.end();
  }
});
