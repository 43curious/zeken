import db from '../../lib/db';
import { json, requireCurrentUser } from '../../lib/server-auth';
import type { AstroCookies } from 'astro';

export async function GET({ url, cookies }: { url: URL; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const year = Number(url.searchParams.get('year') || new Date().getFullYear());

  // 1. Get all pools
  const poolsRes = await db.execute({
    sql: 'SELECT * FROM pools WHERE userId = ? ORDER BY created ASC',
    args: [user.id]
  });

  // Calculate Rollover (Cumulative net income up to this year/month)
  // We'll calculate the total savings from the start of time for this user
  const netRes = await db.execute({
    sql: 'SELECT type, SUM(amount) as total FROM records WHERE userId = ? GROUP BY type',
    args: [user.id]
  });
  
  let totalIncome = 0;
  let totalExpense = 0;
  for (const row of netRes.rows) {
    if (row.type === 'income') totalIncome = Number(row.total);
    else totalExpense = Number(row.total);
  }
  
  const withdrawalSumRes = await db.execute({
    sql: 'SELECT SUM(amount) as total FROM pool_withdrawals WHERE userId = ?',
    args: [user.id]
  });
  const totalWithdrawalsOverall = Number(withdrawalSumRes.rows[0].total || 0);
  
  // Overall Rollover (Savings accessible to pools or just general savings)
  const overallRollover = totalIncome - totalExpense;

  if (poolsRes.rows.length === 0) {
    return json([{
      id: 'rollover',
      name: 'Total Rollover',
      type: 'rollover',
      balance: overallRollover,
      availableBalance: overallRollover
    }]);
  }

  const poolIds = poolsRes.rows.map(p => p.id as string);

  // Batch parallel queries
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
            WHERE poolId IN (${poolIds.map(() => '?').join(',')})`,
      args: poolIds
    }),
    db.execute({
      sql: `SELECT pc.poolId, r.type, SUM(r.amount) as total
            FROM records r
            JOIN pool_categories pc ON pc.categoryId = r.categoryId
            WHERE r.userId = ? AND pc.poolId IN (${poolIds.map(() => '?').join(',')})
            GROUP BY pc.poolId, r.type`,
      args: [user.id, ...poolIds]
    })
  ]);

  const categoriesByPool = new Map<string, any[]>();
  for (const row of allCategoriesRes.rows) {
    const pid = row.poolId as string;
    if (!categoriesByPool.has(pid)) categoriesByPool.set(pid, []);
    categoriesByPool.get(pid)!.push({ id: row.id, name: row.name, emoji: row.emoji, color: row.color });
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

  const pools = poolsRes.rows.map(row => {
    const pid = row.id as string;
    const linkedCategories = categoriesByPool.get(pid) || [];
    const withdrawals = withdrawalsByPool.get(pid) || [];
    const sums = recordSumsByPool.get(pid) || { income: 0, expense: 0 };
    const wSum = withdrawalSumByPool.get(pid) || 0;
    const startBal = Number(row.startingBalance || 0);
    
    // Balance = Starting Balance + Linked Expenses - Linked Incomes - Withdrawals
    const balance = startBal + sums.expense - sums.income - wSum;

    return {
      id: row.id as string,
      userId: row.userId as string,
      name: row.name as string,
      type: row.type as string,
      target: row.target as number | null,
      startingBalance: row.startingBalance as number,
      isClosed: Boolean(row.isClosed),
      created: row.created as string,
      balance,
      totalWithdrawals: wSum,
      availableBalance: balance,
      linkedCategories,
      withdrawals,
      linkedCategoryIds: linkedCategories.map((c: any) => c.id)
    };
  });

  // Add virtual rollover pool at the beginning
  pools.unshift({
    id: 'rollover',
    userId: user.id,
    name: 'Total Rollover',
    type: 'rollover',
    target: null,
    startingBalance: 0,
    isClosed: false,
    created: new Date().toISOString(),
    balance: overallRollover,
    totalWithdrawals: 0,
    availableBalance: overallRollover,
    linkedCategories: [],
    withdrawals: [],
    linkedCategoryIds: []
  });

  return json(pools, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600'
    }
  });
}

export async function POST({ request, cookies }: { request: Request; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const data = await request.json();
  const { name, linkedCategoryIds, target, startingBalance, type = 'savings' } = data;

  if (!name || !Array.isArray(linkedCategoryIds)) {
    return json({ error: 'Name and linked categories are required.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.batch([
    {
        sql: 'INSERT INTO pools (id, userId, name, type, target, startingBalance) VALUES (?, ?, ?, ?, ?, ?)',
        args: [id, user.id, name, type, target || null, startingBalance || 0]
    },
    ...linkedCategoryIds.map((catId: string) => ({
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
  const { poolId, amount, description, date, isClosed, name, linkedCategoryIds, target, startingBalance } = data;

  // Handle pool updates (edit)
  if (poolId && (name !== undefined || linkedCategoryIds !== undefined || target !== undefined || startingBalance !== undefined)) {
    const updates = [];
    const args = [];
    if (name !== undefined) { updates.push('name = ?'); args.push(name); }
    if (target !== undefined) { updates.push('target = ?'); args.push(target); }
    if (startingBalance !== undefined) { updates.push('startingBalance = ?'); args.push(startingBalance); }
    
    if (updates.length > 0) {
      args.push(poolId, user.id);
      await db.execute({
        sql: `UPDATE pools SET ${updates.join(', ')} WHERE id = ? AND userId = ?`,
        args
      });
    }

    if (linkedCategoryIds !== undefined) {
      await db.execute({ sql: 'DELETE FROM pool_categories WHERE poolId = ?', args: [poolId] });
      if (linkedCategoryIds.length > 0) {
        await db.batch(linkedCategoryIds.map((catId: string) => ({
          sql: 'INSERT INTO pool_categories (poolId, categoryId) VALUES (?, ?)',
          args: [poolId, catId]
        })), "write");
      }
    }
    return json({ success: true });
  }

  // Handle pool status (isClosed)
  if (isClosed !== undefined) {
    if (!poolId) return json({ error: 'Pool ID is required.' }, { status: 400 });
    await db.execute({
        sql: 'UPDATE pools SET isClosed = ? WHERE id = ? AND userId = ?',
        args: [isClosed ? 1 : 0, poolId, user.id]
    });
    return json({ success: true });
  }

  // Handle withdrawals (Old logic still here)
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

export async function DELETE({ request, cookies }: { request: Request; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const { id } = await request.json();
  if (!id) return json({ error: 'Pool ID is required.' }, { status: 400 });

  await db.execute({
    sql: 'DELETE FROM pools WHERE id = ? AND userId = ?',
    args: [id, user.id]
  });

  return json({ success: true });
}
