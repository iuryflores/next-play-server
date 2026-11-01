// Explicit one-off migration. Never prints connection strings or document contents.
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { mkdir, writeFile } = require('node:fs/promises');
const { gzipSync } = require('node:zlib');
const { join } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !/^mongodb\+srv:\/\//.test(uri)) throw new Error('Atlas destination required');
  const source = mongoose.createConnection('mongodb://127.0.0.1:27017/nextplay', { serverSelectionTimeoutMS: 10000 });
  const target = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await Promise.all([source.asPromise(), target.asPromise()]);
    if (source.name !== 'nextplay' || target.name !== 'nextplay') throw new Error('Unexpected database name');
    const collections = await source.db.listCollections({}, { nameOnly: false }).toArray();
    const snapshot = [];
    for (const info of collections) {
      if (info.type !== 'collection' || info.name.startsWith('system.')) throw new Error('Unsupported collection type');
      snapshot.push({ name: info.name, options: info.options, indexes: await source.collection(info.name).indexes(), documents: await source.collection(info.name).find({}).toArray() });
    }
    // No overwrite or merge: refuse a destination containing any documents.
    for (const info of await target.db.listCollections().toArray()) {
      if (await target.collection(info.name).countDocuments()) throw new Error('Destination must be empty');
    }
    const directory = join(__dirname, '..', '.migration-backups');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `nextplay-${new Date().toISOString().replace(/[:.]/g, '-')}.ejson.gz`);
    await writeFile(file, gzipSync(EJSON.stringify(snapshot, { relaxed: false })), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ backup: file, collections: snapshot.length, documents: snapshot.reduce((n, c) => n + c.documents.length, 0) }));
    for (const collection of snapshot) {
      const { name, documents, indexes, options } = collection;
      const exists = await target.db.listCollections({ name }).hasNext();
      if (!exists) await target.db.createCollection(name, options);
      for (const index of indexes) {
        if (index.name === '_id_') continue;
        const { key, v, ns, ...indexOptions } = index;
        await target.collection(name).createIndex(key, indexOptions);
      }
      for (let start = 0; start < documents.length; start += 250) {
        await target.collection(name).insertMany(documents.slice(start, start + 250), { ordered: true });
      }
      console.log(JSON.stringify({ copied: name, count: documents.length }));
    }
    for (const { name, documents, indexes } of snapshot) {
      const actual = await target.collection(name).find({}).toArray();
      assert.equal(actual.length, documents.length, `Count mismatch: ${name}`);
      const byId = new Map(actual.map(doc => [EJSON.stringify(doc._id), doc]));
      for (const doc of documents) assert.deepStrictEqual(byId.get(EJSON.stringify(doc._id)), doc, `Document mismatch: ${name}`);
      const actualIndexes = await target.collection(name).indexes();
      for (const index of indexes) {
        const restored = actualIndexes.find(i => i.name === index.name);
        assert.ok(restored, `Missing index: ${name}`);
        for (const [key, value] of Object.entries(index)) {
          if (!['v', 'ns'].includes(key)) assert.deepStrictEqual(restored[key], value, `Index mismatch: ${name}`);
        }
      }
      // Detect source changes during the copy instead of claiming a consistent result.
      const current = await source.collection(name).find({}).toArray();
      assert.equal(current.length, documents.length, `Source changed: ${name}`);
      const original = new Map(documents.map(doc => [EJSON.stringify(doc._id), doc]));
      for (const doc of current) assert.deepStrictEqual(original.get(EJSON.stringify(doc._id)), doc, `Source changed: ${name}`);
    }
    console.log(JSON.stringify({ verified: true, sourcePreserved: true }));
  } finally { await Promise.allSettled([source.close(), target.close()]); }
}
main().catch(error => {
  console.error(JSON.stringify({ migrationFailed: true, type: error.name, code: error.code || null }));
  process.exitCode = 1;
});
