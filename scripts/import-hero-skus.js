'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('../src/config'); // Load .env if present
const db = require('../src/db');
const { createProduct, updateProduct, ean13CheckDigit } = require('../src/services/products');
const { insertShop } = require('../src/routes/shop');
const { roundHalfUpDiv } = require('../src/money');

/** Barcode EAN-13 generator with prefix 2008852 */
function heroBarcode(heroIndex, unitNo = 1) {
  const first12 = `2008852${String(heroIndex).padStart(3, '0')}${unitNo}0`;
  return first12 + ean13CheckDigit(first12);
}

/** Parse THB string (e.g. "320", "7.6", "125.50") directly to BigInt satang without float math */
function parseThbToSatang(str) {
  const trimmed = String(str ?? '').trim();
  const m = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) {
    throw new Error(`Invalid THB amount: "${str}"`);
  }
  const whole = BigInt(m[1]);
  const fraction = m[2] || '';
  if (fraction.length === 0) {
    return whole * 100n;
  } else if (fraction.length === 1) {
    return whole * 100n + BigInt(fraction) * 10n;
  } else if (fraction.length === 2) {
    return whole * 100n + BigInt(fraction);
  } else {
    // Round half up to 2 decimal places (satang)
    const satangBase = BigInt(fraction.slice(0, 2));
    const nextDigit = Number(fraction[2]);
    const roundUp = nextDigit >= 5 ? 1n : 0n;
    return whole * 100n + satangBase + roundUp;
  }
}

/** Parse THB range (e.g. "320-360", "189", "75-95") into { low, high } BigInt satang */
function parseRange(str) {
  const trimmed = String(str ?? '').trim();
  const parts = trimmed.split('-');
  if (parts.length === 1) {
    const val = parseThbToSatang(parts[0]);
    return { low: val, high: val };
  } else if (parts.length === 2) {
    const low = parseThbToSatang(parts[0]);
    const high = parseThbToSatang(parts[1]);
    return { low, high };
  }
  throw new Error(`Invalid range format: "${str}"`);
}

/** Format BigInt satang into THB string with 2 decimal places */
function satangToThb(satang) {
  const s = BigInt(satang);
  const sign = s < 0n ? '-' : '';
  const abs = s < 0n ? -s : s;
  const whole = abs / 100n;
  const rem = abs % 100n;
  return `${sign}${whole}.${rem.toString().padStart(2, '0')}`;
}

/** Simple CSV parser supporting quotes */
function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const header = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (!cols.length) continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j].trim()] = cols[j] ? cols[j].trim() : '';
    }
    rows.push(obj);
  }
  return rows;
}

const HERO_DEFINITIONS = [
  {
    code: 'SF-HERO-01',
    heroIndex: 1,
    displayName: 'Snow Fish Kirimi 100g',
    csvSource: { type: 'single', productName: 'Snow Fish Kirimi (ปลาหิมะ 100g)' },
  },
  {
    code: 'SF-HERO-02',
    heroIndex: 2,
    displayName: 'Norwegian Salmon Steak 150g',
    csvSource: { type: 'single', productName: 'Salmon Steak Cut 150-160g' },
  },
  {
    code: 'SF-HERO-03',
    heroIndex: 3,
    displayName: 'Japanese Hotate Sashimi L (3 pcs)',
    csvSource: { type: 'single', productName: 'Japan Hotate Sashimi Grade L' },
  },
  {
    code: 'SF-HERO-04',
    heroIndex: 4,
    displayName: 'Tuna Saku AAA 120-150g',
    csvSource: { type: 'single', productName: 'Tuna Saku AAA' },
  },
  {
    code: 'SF-HERO-05',
    heroIndex: 5,
    displayName: 'Unagi Kabayaki 145g',
    csvSource: { type: 'single', productName: 'Unagi Kabayaki 70P (ปลาไหลย่าง)' },
  },
  {
    code: 'SF-HERO-06',
    heroIndex: 6,
    displayName: 'Kani Miso 60g + Crab Shell',
    csvSource: {
      type: 'combo',
      priceProduct: 'Frozen Kani Miso 300g',
      costProducts: ['Frozen Kani Miso 300g', 'Snow Crab Shell 9-11cm'],
    },
  },
  {
    code: 'SF-HERO-07',
    heroIndex: 7,
    displayName: 'NZ PS Ribeye 180g',
    csvSource: { type: 'single', productName: 'NZ PS Ribeye (Cube Roll)' },
  },
];

function loadHeroSkusFromCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }
  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(content);
  const rowsByName = new Map();
  for (const r of rows) {
    if (r.Product_Name) {
      rowsByName.set(r.Product_Name.trim(), r);
    }
  }

  return HERO_DEFINITIONS.map((def) => {
    let priceSatang;
    let costSatang;

    if (def.csvSource.type === 'single') {
      const row = rowsByName.get(def.csvSource.productName);
      if (!row) {
        throw new Error(`Missing required CSV row for product: "${def.csvSource.productName}"`);
      }
      const priceRange = parseRange(row.Recommended_Selling_Price_THB);
      priceSatang = priceRange.low; // Low end of range

      const costRange = parseRange(row.Raw_Cost_Per_Portion_THB);
      costSatang = roundHalfUpDiv(costRange.low + costRange.high, 2n); // Midpoint
    } else if (def.csvSource.type === 'combo') {
      const priceRow = rowsByName.get(def.csvSource.priceProduct);
      if (!priceRow) {
        throw new Error(`Missing required CSV row for product: "${def.csvSource.priceProduct}"`);
      }
      const priceRange = parseRange(priceRow.Recommended_Selling_Price_THB);
      priceSatang = priceRange.low;

      let sumCost = 0n;
      for (const pName of def.csvSource.costProducts) {
        const costRow = rowsByName.get(pName);
        if (!costRow) {
          throw new Error(`Missing required CSV row for product: "${pName}"`);
        }
        const costRange = parseRange(costRow.Raw_Cost_Per_Portion_THB);
        sumCost += roundHalfUpDiv(costRange.low + costRange.high, 2n);
      }
      costSatang = sumCost;
    }

    return {
      code: def.code,
      heroIndex: def.heroIndex,
      displayName: def.displayName,
      priceSatang,
      costSatang,
    };
  });
}

function parseArgs(argv) {
  let ownerEmail = process.env.OWNER_EMAIL || '';
  let shopName = process.env.SHOP_NAME || 'Sea farmer (by Daiseiko)';
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--owner-email=')) {
      ownerEmail = arg.slice('--owner-email='.length);
    } else if (arg === '--owner-email' && i + 1 < argv.length) {
      ownerEmail = argv[++i];
    } else if (arg.startsWith('--shop-name=')) {
      shopName = arg.slice('--shop-name='.length);
    } else if (arg === '--shop-name' && i + 1 < argv.length) {
      shopName = argv[++i];
    }
  }

  ownerEmail = ownerEmail.trim();
  shopName = shopName.trim();

  if (!ownerEmail) {
    throw new Error('OWNER_EMAIL is required (specify via OWNER_EMAIL env var or --owner-email=)');
  }

  return { ownerEmail, shopName, dryRun };
}

async function run() {
  const { ownerEmail, shopName, dryRun } = parseArgs(process.argv);
  const csvPath = path.join(__dirname, 'sku_cost_estimation.csv');
  const heroSkus = loadHeroSkusFromCsv(csvPath);

  // 1. Ensure migrations are applied
  await db.migrate();

  if (dryRun) {
    const client = await db.pool.connect();
    try {
      const { rows: userRows } = await client.query(
        'SELECT id FROM users WHERE email = $1 AND is_demo = false',
        [ownerEmail]
      );
      let shop = null;
      if (userRows.length > 0) {
        const { rows: shopRows } = await client.query(
          'SELECT id FROM shops WHERE owner_user_id = $1 AND name = $2',
          [userRows[0].id, shopName]
        );
        if (shopRows.length > 0) {
          shop = shopRows[0];
        }
      }

      const existingCodes = new Set();
      if (shop) {
        const { rows: prodRows } = await client.query(
          'SELECT code FROM products WHERE shop_id = $1 AND code = ANY($2::text[])',
          [shop.id, heroSkus.map((s) => s.code)]
        );
        for (const r of prodRows) {
          existingCodes.add(r.code);
        }
      }

      console.log(`[DRY RUN] Plan for shop "${shopName}" (owner: ${ownerEmail}):`);
      const plan = heroSkus.map((sku) => ({
        code: sku.code,
        name: sku.displayName,
        'price THB': satangToThb(sku.priceSatang),
        'cost THB': satangToThb(sku.costSatang),
        status: existingCodes.has(sku.code) ? 'update' : 'create',
      }));
      console.table(plan);
      return;
    } finally {
      client.release();
    }
  }

  // Real execution in transaction
  const summary = await db.tx(async (client) => {
    // 1. Find user by email (is_demo = false) or insert
    const { rows: userRows } = await client.query(
      'SELECT id, email, name FROM users WHERE email = $1 AND is_demo = false',
      [ownerEmail]
    );
    let user;
    if (userRows.length > 0) {
      user = userRows[0];
    } else {
      const userName = ownerEmail.split('@')[0] || 'Owner';
      const { rows: inserted } = await client.query(
        `INSERT INTO users (email, name, is_demo)
         VALUES ($1, $2, false)
         RETURNING id, email, name`,
        [ownerEmail, userName]
      );
      user = inserted[0];
    }

    // 2. Find shop where owner_user_id = user and name = shopName or insertShop
    const { rows: shopRows } = await client.query(
      'SELECT id, name FROM shops WHERE owner_user_id = $1 AND name = $2',
      [user.id, shopName]
    );
    let shop;
    if (shopRows.length > 0) {
      shop = shopRows[0];
    } else {
      shop = await insertShop(client, user.id, { name: shopName });
    }

    // Ensure shop_members OWNER row
    await client.query(
      `INSERT INTO shop_members (shop_id, user_id, role)
       VALUES ($1, $2, 'OWNER')
       ON CONFLICT (shop_id, user_id) DO NOTHING`,
      [shop.id, user.id]
    );

    // 3. Products
    const results = [];
    for (const sku of heroSkus) {
      const { rows: existingRows } = await client.query(
        'SELECT id, code, name, min_stock_base, image_url FROM products WHERE shop_id = $1 AND code = $2',
        [shop.id, sku.code]
      );

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        // Keep existing barcode
        const { rows: bcRows } = await client.query(
          'SELECT barcode FROM barcodes WHERE shop_id = $1 AND product_id = $2 ORDER BY id ASC LIMIT 1',
          [shop.id, existing.id]
        );
        const barcode = bcRows.length > 0 ? bcRows[0].barcode : heroBarcode(sku.heroIndex, 1);

        const updateInput = {
          code: sku.code,
          name: sku.displayName,
          baseUnitCode: 'PCS',
          baseUnitName: 'แพ็ค',
          costBaseSatang: sku.costSatang,
          minStockBase: existing.min_stock_base !== undefined ? Number(existing.min_stock_base) : 5,
          imageUrl: existing.image_url || '',
          units: [{ unitCode: 'PCS', unitName: 'แพ็ค', standValue: 1, divideValue: 1 }],
          barcodes: [
            {
              barcode,
              unitCode: 'PCS',
              priceSatang: sku.priceSatang,
              priceMemberSatang: 0n,
              priceWholesaleSatang: 0n,
            },
          ],
        };
        await updateProduct(client, shop.id, existing.id, updateInput);
        results.push({
          code: sku.code,
          name: sku.displayName,
          priceSatang: sku.priceSatang,
          costSatang: sku.costSatang,
          status: 'updated',
        });
      } else {
        const createInput = {
          code: sku.code,
          name: sku.displayName,
          baseUnitCode: 'PCS',
          baseUnitName: 'แพ็ค',
          costBaseSatang: sku.costSatang,
          minStockBase: 5,
          openingStock: 0,
          imageUrl: '',
          units: [{ unitCode: 'PCS', unitName: 'แพ็ค', standValue: 1, divideValue: 1 }],
          barcodes: [
            {
              barcode: heroBarcode(sku.heroIndex, 1),
              unitCode: 'PCS',
              priceSatang: sku.priceSatang,
              priceMemberSatang: 0n,
              priceWholesaleSatang: 0n,
            },
          ],
        };
        await createProduct(client, shop.id, user.id, createInput);
        results.push({
          code: sku.code,
          name: sku.displayName,
          priceSatang: sku.priceSatang,
          costSatang: sku.costSatang,
          status: 'created',
        });
      }
    }
    return results;
  });

  console.log(`Imported hero SKUs for shop "${shopName}" (owner: ${ownerEmail}):`);
  console.table(
    summary.map((item) => ({
      code: item.code,
      name: item.name,
      'price THB': satangToThb(item.priceSatang),
      'cost THB': satangToThb(item.costSatang),
      status: item.status,
    }))
  );
}

async function main() {
  try {
    await run();
  } catch (err) {
    console.error('[import-hero-skus] Error:', err.message || err);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  heroBarcode,
  parseThbToSatang,
  parseRange,
  satangToThb,
  loadHeroSkusFromCsv,
  HERO_DEFINITIONS,
};
