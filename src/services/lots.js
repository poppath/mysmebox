'use strict';
// ล็อต/วันหมดอายุ: รับเข้าเป็นล็อต, ตัดแบบ FEFO (หมดอายุก่อนออกก่อน), คืนล็อตเดิมเมื่อยกเลิก
const { str, int, badRequest, notFound } = require('../http');
const { adjustStock } = require('./products');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) {
    throw badRequest(`${label}ต้องเป็นวันที่รูปแบบ YYYY-MM-DD`);
  }
  return s;
}

const fmtDate = (d) => (d ? (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10)) : null);

function lotJson(r) {
  return {
    id: r.id,
    lotNo: r.lot_no,
    mfgDate: fmtDate(r.mfg_date),
    expDate: fmtDate(r.exp_date),
    qtyReceived: Number(r.qty_received),
    qtyBase: Number(r.qty_base),
    note: r.note,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

function parseLotInput(b) {
  const input = {
    lotNo: str(b.lotNo, 'เลขล็อต', { max: 60 }),
    mfgDate: dateOrNull(b.mfgDate, 'วันผลิต'),
    expDate: dateOrNull(b.expDate, 'วันหมดอายุ'),
    qtyBase: int(b.qtyBase, 'จำนวน', { min: 1, max: 1e9 }),
    note: str(b.note, 'หมายเหตุ', { max: 500 }),
  };
  if (input.mfgDate && input.expDate && input.expDate < input.mfgDate) throw badRequest('วันหมดอายุต้องไม่ก่อนวันผลิต');
  return input;
}

/** รับเข้าเป็นล็อต: เพิ่ม stock_base (RECEIVE movement) + สร้างแถวล็อต — ต้องอยู่ใน transaction */
async function receiveLot(client, shopId, userId, productId, input) {
  const note = [input.lotNo && `ล็อต ${input.lotNo}`, input.expDate && `หมดอายุ ${input.expDate}`, input.note].filter(Boolean).join(' · ');
  await adjustStock(client, shopId, userId, productId, { type: 'RECEIVE', qtyBase: input.qtyBase, note });
  const { rows } = await client.query(
    `INSERT INTO stock_lots (shop_id, product_id, lot_no, mfg_date, exp_date, qty_received, qty_base, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8) RETURNING *`,
    [shopId, productId, input.lotNo, input.mfgDate, input.expDate, String(input.qtyBase), input.note, userId || null]
  );
  return lotJson(rows[0]);
}

async function lockLots(client, shopId, productId) {
  const { rows } = await client.query(
    `SELECT id, qty_base FROM stock_lots WHERE shop_id = $1 AND product_id = $2 AND qty_base > 0
      ORDER BY exp_date NULLS LAST, id FOR UPDATE`,
    [shopId, productId]
  );
  return rows;
}

/**
 * ตัดสต๊อกแบบ FEFO จากล็อตก่อน แล้วค่อยใช้ส่วน "ไม่ระบุล็อต"
 * (สต๊อกเดิมก่อนมีระบบล็อตไม่หายไป — ถ้าล็อตไม่พอก็ขายจากส่วนนี้)
 * billId = null → ไม่บันทึก allocation (เช่นปรับลด)
 */
async function consumeFefo(client, { shopId, productId, qty, billId = null }) {
  let left = BigInt(qty);
  for (const lot of await lockLots(client, shopId, productId)) {
    if (left <= 0n) break;
    const take = BigInt(lot.qty_base) < left ? BigInt(lot.qty_base) : left;
    await client.query('UPDATE stock_lots SET qty_base = qty_base - $2 WHERE id = $1', [lot.id, take.toString()]);
    if (billId) {
      await client.query('INSERT INTO stock_lot_allocations (bill_id, lot_id, product_id, qty_base) VALUES ($1, $2, $3, $4)', [billId, lot.id, productId, take.toString()]);
    }
    left -= take;
  }
  return left; // ส่วนที่ตัดจาก "ไม่ระบุล็อต"
}

/** หลังปรับลดสต๊อก: ถ้ายอดล็อตรวมเกิน stock_base ให้ตัดล็อตส่วนเกินแบบ FEFO */
async function trimLotsToBalance(client, shopId, productId, balance) {
  const { rows } = await client.query('SELECT COALESCE(SUM(qty_base), 0)::bigint AS s FROM stock_lots WHERE shop_id = $1 AND product_id = $2', [shopId, productId]);
  const excess = BigInt(rows[0].s) - BigInt(balance);
  if (excess > 0n) await consumeFefo(client, { shopId, productId, qty: excess });
}

/** ยกเลิกบิล: คืนจำนวนเข้าล็อตเดิมตาม allocation */
async function returnLots(client, billId) {
  const { rows } = await client.query(
    'UPDATE stock_lot_allocations SET returned_at = NOW() WHERE bill_id = $1 AND returned_at IS NULL RETURNING lot_id, qty_base',
    [billId]
  );
  for (const a of rows.sort((x, y) => Number(x.lot_id) - Number(y.lot_id))) {
    await client.query('UPDATE stock_lots SET qty_base = qty_base + $2 WHERE id = $1', [a.lot_id, a.qty_base]);
  }
}

async function listLots(client, shopId, productId, { all = false } = {}) {
  const p = await client.query('SELECT stock_base FROM products WHERE shop_id = $1 AND id = $2', [shopId, productId]);
  if (!p.rowCount) throw notFound('ไม่พบสินค้า');
  const { rows } = await client.query(
    `SELECT * FROM stock_lots WHERE shop_id = $1 AND product_id = $2 ${all ? '' : 'AND qty_base > 0'}
      ORDER BY exp_date NULLS LAST, id LIMIT 200`,
    [shopId, productId]
  );
  const lots = rows.map(lotJson);
  const inLots = rows.reduce((s, r) => s + BigInt(r.qty_base), 0n);
  return { lots, untrackedBase: Number(BigInt(p.rows[0].stock_base) - inLots) };
}

/** ล็อตที่ใกล้หมดอายุ (หรือหมดแล้ว) ภายใน days วัน ตามเวลาไทย */
async function nearExpiry(client, shopId, days, limit = 20) {
  const { rows } = await client.query(
    `SELECT l.*, p.name, p.code, p.base_unit_name,
            (l.exp_date - (NOW() AT TIME ZONE 'Asia/Bangkok')::date) AS days_left
       FROM stock_lots l JOIN products p ON p.id = l.product_id
      WHERE l.shop_id = $1 AND l.qty_base > 0 AND l.exp_date IS NOT NULL AND p.is_active
        AND l.exp_date <= (NOW() AT TIME ZONE 'Asia/Bangkok')::date + $2::int
      ORDER BY l.exp_date, l.id LIMIT $3`,
    [shopId, days, limit]
  );
  return rows.map((r) => ({ ...lotJson(r), productId: r.product_id, name: r.name, code: r.code, baseUnitName: r.base_unit_name, daysLeft: Number(r.days_left) }));
}

module.exports = { DATE_RE, dateOrNull, lotJson, parseLotInput, receiveLot, consumeFefo, trimLotsToBalance, returnLots, listLots, nearExpiry };
