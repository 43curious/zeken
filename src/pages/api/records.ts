import db from '../../lib/db';
import { json, requireCurrentUser } from '../../lib/server-auth';
import type { AstroCookies } from 'astro';

export async function GET({ url, cookies }: { url: URL; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');

  let sql = 'SELECT * FROM records WHERE userId = ?';
  const args: any[] = [user.id];

  if (year && month) {
    sql += ' AND date LIKE ?';
    args.push(`${year}-${month.padStart(2, '0')}-%`);
  } else if (year) {
    sql += ' AND date LIKE ?';
    args.push(`${year}-%`);
  }

  sql += ' ORDER BY date DESC, created DESC';

  const res = await db.execute({ sql, args });
  return json(res.rows, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600'
    }
  });
}

export async function POST({ request, cookies }: { request: Request; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const data = await request.json();
  const type = data.type;
  const name = String(data.name ?? '').trim();
  const amount = Number(data.amount);
  const categoryId = String(data.categoryId ?? '').trim();
  const location = String(data.location ?? '').trim();
  const date = String(data.date ?? '').trim();

  if (!type || !name || !Number.isFinite(amount) || amount <= 0 || !categoryId || !date) {
    return json({ error: 'Please provide a valid type, name, amount, category, and date.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  
  await db.batch([
    {
      sql: `INSERT INTO records (id, userId, type, name, amount, categoryId, location, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, user.id, type, name, amount, categoryId, location, date]
    },
    {
      sql: type === 'income' 
           ? 'UPDATE users SET bankBalance = bankBalance + ? WHERE id = ?'
           : 'UPDATE users SET bankBalance = bankBalance - ? WHERE id = ?',
      args: [amount, user.id]
    }
  ], "write");

  const recordRes = await db.execute({
    sql: 'SELECT * FROM records WHERE id = ? AND userId = ?',
    args: [id, user.id]
  });
  
  return json(recordRes.rows[0], { status: 201 });
}

export async function DELETE({ request, cookies }: { request: Request; cookies: AstroCookies }) {
  const { user, response } = await requireCurrentUser(cookies);
  if (!user) return response;

  const { id } = await request.json();
  if (!id) return json({ error: 'Record id is required.' }, { status: 400 });

  const recordRes = await db.execute({
    sql: 'SELECT type, amount FROM records WHERE id = ? AND userId = ?',
    args: [id, user.id]
  });
  
  if (recordRes.rows.length === 0) return json({ error: 'Record not found.' }, { status: 404 });
  const record = recordRes.rows[0];

  await db.batch([
    { sql: 'DELETE FROM records WHERE id = ? AND userId = ?', args: [id, user.id] },
    {
      sql: (record.type as string) === 'income'
           ? 'UPDATE users SET bankBalance = bankBalance - ? WHERE id = ?'
           : 'UPDATE users SET bankBalance = bankBalance + ? WHERE id = ?',
      args: [Number(record.amount), user.id]
    }
  ], "write");

  return json({ success: true });
}
