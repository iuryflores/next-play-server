// Read-only by default. Apply only to an explicitly selected owner.
const mongoose = require('mongoose');
const { getConfig } = require('../dist/config');
const { CatalogService } = require('../dist/catalog/catalog.module');
const { resolveActor } = require('../dist/library/actor-votes');
async function main() {
  const db = await mongoose.createConnection(getConfig().mongoUri).asPromise();
  try {
    const ownerArg = process.argv.find(value => value.startsWith('--owner='))?.slice(8);
    const owners = await db.collection('library_items').distinct('ownerId');
    if (!ownerArg) { console.log(JSON.stringify({ owners: owners.map(String) })); return; }
    if (!/^[a-f0-9]{24}$/i.test(ownerArg)) throw Error('Invalid owner');
    const ownerId = new mongoose.Types.ObjectId(ownerArg);
    const apply = process.argv.includes('--apply');
    const catalog = new CatalogService(db);
    const items = await db.collection('library_items').find({ ownerId }).toArray();
    const rows = await db.collection('episode_progress').find({ itemId: { $in: items.map(item => item._id) } }).toArray();
    const votes = [...items.filter(item => item.favoriteCharacter && !item.favoriteActorId).map(item => ({ row: item, item, collection: 'library_items' })), ...rows.filter(row => row.favoriteCharacter && !row.favoriteActorId).map(row => ({ row, item: items.find(item => item._id.equals(row.itemId)), collection: 'episode_progress' }))];
    let updated = 0, resolvable = 0, unavailable = 0;
    const unresolved = [];
    const loaded = new Set();
    for (const { row, item, collection } of votes) {
      const catalogId = item.catalogId;
      let caches = catalogId ? await db.collection('catalog_cast').find({ _id: { $regex: '^' + catalogId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':' } }).toArray() : [];
      const vote = { ...row, catalogId, name: row.favoriteCharacter, kind: item.kind };
      let actor = resolveActor(vote, caches);
      // Refresh only missing matches, once per title/context. Never guess from actor names.
      if (!actor && apply && /^tmdb:(movie|series):[0-9]+$/.test(catalogId || '')) {
        const key = `${catalogId}:${row.season ?? 'all'}:${row.episode ?? 'all'}`;
        if (!loaded.has(key)) {
          loaded.add(key);
          try { await catalog.cast(catalogId, 'en-US', row.season, row.episode); } catch { unavailable++; }
        }
        caches = await db.collection('catalog_cast').find({ _id: { $regex: '^' + catalogId + ':' } }).toArray();
        actor = resolveActor(vote, caches);
      }
      if (!actor) { unresolved.push({ title: item.title, character: row.favoriteCharacter }); continue; }
      resolvable++;
      if (apply) {
        const result = await db.collection(collection).updateOne({ _id: row._id, ...(collection === 'library_items' ? { ownerId } : { itemId: item._id }), favoriteCharacter: row.favoriteCharacter, $or: [{ favoriteActorId: { $exists: false } }, { favoriteActorId: '' }, { favoriteActorId: null }] }, { $set: { favoriteCastId: actor.castId, favoriteActorId: actor.id, favoriteActorName: actor.name, favoriteActorPhoto: actor.photo } });
        updated += result.modifiedCount;
      }
    }
    console.log(JSON.stringify({ apply, examined: votes.length, resolvable, updated, unavailable, unresolved: unresolved.length, unresolvedTitles: [...new Set(unresolved.map(entry => entry.title))] }));
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.name + ': migration failed'); process.exitCode = 1; });
