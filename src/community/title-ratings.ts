import type { Connection } from 'mongoose';

const stars = [5, 4, 3, 2, 1];

export async function communityRatings(connection: Connection, keys: string[]) {
  // Cada conta contribui somente com o registro mais recente de cada título.
  const rows = await connection.collection('library_items').aggregate<{ _id: { key: string; stars: number }; count: number }>([
    { $match: { catalogKey: { $in: keys } } },
    { $sort: { updatedAt: -1, _id: -1 } },
    { $group: { _id: { key: '$catalogKey', owner: '$ownerId' }, stars: { $first: '$stars' }, status: { $first: '$status' } } },
    { $match: { status: 'completed', stars: { $in: stars } } },
    { $group: { _id: { key: '$_id.key', stars: '$stars' }, count: { $sum: 1 } } },
  ]).toArray();
  const counts = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const values = counts.get(row._id.key) ?? new Map<number, number>();
    values.set(row._id.stars, row.count);
    counts.set(row._id.key, values);
  }
  return new Map(keys.map(key => {
    const distribution = stars.map(value => ({ stars: value, count: counts.get(key)?.get(value) ?? 0 }));
    const count = distribution.reduce((sum, row) => sum + row.count, 0);
    const total = distribution.reduce((sum, row) => sum + row.stars * row.count, 0);
    return [key, { count, average: count ? Math.round(total / count * 100) / 100 : null, distribution }];
  }));
}
