import db from '../../lib/db';
import { json, requireCurrentUser } from '../../lib/server-auth';
import type { AstroCookies } from 'astro';

export async function GET({ url, cookies }: { url: URL; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const year = Number(url.searchParams.get('year') || new Date().getFullYear());

  // Single query: get all pools
  const poolsRes = await db.execute({
    sql: 'SELECT * FROM pools WHERE userId = ? ORDER BY created ASC',
    args: [user.id]
  });

  if (poolsRes.rows.length === 0) return json([]);

  const poolIds = poolsRes.rows.map(p => p.id as string);

  // Batch: get all linked categories, withdrawals, and record sums in parallel
  const [allCategoriesRes, allWithdrawalsRes, allRecordSumsRes] = await Promise.all([
    db.execute({
      sql: `SELECT pc.poolId, c.id, c.name, c.emoji, c.color
            FROM pool_categories pc
            JOIN categories c ON c.id = pc.categoryId
            WHERE pc.poolId IN (${poolIds.map(() => '?').join(',')})`,
      args: poolIds
    }),
    db.execute({
      sql: `SELECT * FROM pool_withdrawals
            WHERE poolId IN (${poolIds.map(() => '?').join(',')})
            AND date BETWEEN ? AND ?`,
      args: [...poolIds, `${year}-01-01`, `${year}-12-31`]
    }),
    // Get all record sums grouped by categoryId and type for categories linked to any pool
    db.execute({
      sql: `SELECT pc.poolId, r.type, SUM(r.amount) as total
            FROM records r
            JOIN pool_categories pc ON pc.categoryId = r.categoryId
            WHERE r.userId = ? AND pc.poolId IN (${poolIds.map(() => '?').join(',')})
            GROUP BY pc.poolId, r.type`,
      args: [user.id, ...poolIds]
    })
  ]);

  // Index results by poolId
  const categoriesByPool = new Map<string, any[]>();
  for (const row of allCategoriesRes.rows) {
    const pid = row.poolId as string;
    if (!categoriesByPool.has(pid)) categoriesByPool.set(pid, []);
    categoriesByPool.get(pid)!.push({
      id: row.id,
      name: row.name,
      emoji: row.emoji,
      color: row.color
    });
  }

  const withdrawalsByPool = new Map<string, any[]>();
  let withdrawalSumByPool = new Map<string, number>();
  for (const row of allWithdrawalsRes.rows) {
    const pid = row.poolId as string;
    if (!withdrawalsByPool.has(pid)) withdrawalsByPool.set(pid, []);
    withdrawalsByPool.get(pid)!.push(row);
    withdrawalSumByPool.set(pid, (withdrawalSumByPool.get(pid) || 0) + Number(row.amount));
  }

  const recordSumsByPool = new Map<string, { income: number; expense: number }>();
  for (const row of allRecordSumsRes.rows) {
    const pid = row.poolId as string;
    if (!recordSumsByPool.has(pid)) recordSumsByPool.set(pid, { income: 0, expense: 0 });
    const entry = recordSumsByPool.get(pid)!;
    if (row.type === 'income') entry.income = Number(row.total);
    else entry.expense = Number(row.total);
  }

  // Build final response
  const pools = poolsRes.rows.map(row => {
    const pid = row.id as string;
    const linkedCategories = categoriesByPool.get(pid) || [];
    const withdrawals = withdrawalsByPool.get(pid) || [];
    const sums = recordSumsByPool.get(pid) || { income: 0, expense: 0 };
    const wSum = withdrawalSumByPool.get(pid) || 0;
    const balance = sums.income - sums.expense - wSum;

    return {
      ...row,
      balance,
      totalWithdrawals: wSum,
      availableBalance: balance,
      linkedCategories,
      withdrawals,
      linkedCategoryIds: linkedCategories.map((c: any) => c.id)
    };
  });

  return json(pools);
}

export async function POST({ request, cookies }: { request: Request; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const data = await request.json();
  const { name, linkedCategoryIds, target, type = 'savings' } = data;

  if (!name || !Array.isArray(linkedCategoryIds)) {
    return json({ error: 'Name and linked categories are required.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.batch([
    {
        sql: 'INSERT INTO pools (id, userId, name, type, target) VALUES (?, ?, ?, ?, ?)',
        args: [id, user.id, name, type, target || null]
    },
    ...linkedCategoryIds.map(catId => ({
        sql: 'INSERT INTO pool_categories (poolId, categoryId) VALUES (?, ?)',
        args: [id, catId]
    }))
  ], "write");

  return json({ id, success: true }, { status: 201 });
}

export async function PATCH({ request, cookies }: { request: Request; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const data = await request.json();
  const { poolId, amount, description, date, isClosed } = data;

  if (isClosed !== undefined) {
    if (!poolId) return json({ error: 'Pool ID is required.' }, { status: 400 });
    await db.execute({
        sql: 'UPDATE pools SET isClosed = ? WHERE id = ? AND userId = ?',
        args: [isClosed ? 1 : 0, poolId, user.id]
    });
    return json({ success: true });
  }

  if (!poolId || !amount || !date) {
    return json({ error: 'Pool ID, amount, and date are required.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.execute({
    sql: 'INSERT INTO pool_withdrawals (id, userId, poolId, amount, description, date) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, user.id, poolId, amount, description || '', date]
  });

  return json({ id, success: true });
}
