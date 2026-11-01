const mongoose = require('mongoose');
async function inspect(label, uri) {
  let db;
  try {
    db = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 7000 }).asPromise();
    const collections = await db.db.listCollections({}, { nameOnly: true }).toArray();
    const counts = [];
    for (const { name } of collections) counts.push({ name, count: await db.collection(name).countDocuments() });
    console.log(JSON.stringify({ label, connected: true, database: db.name, collections: counts }));
  } catch (error) { console.log(JSON.stringify({ label, connected: false, errorType: error.name, code: error.code || null })); }
  finally { if (db) await db.close(); }
}
(async () => {
  const uri = process.env.MONGODB_URI;
  console.log(JSON.stringify({ atlasConfigured: !!uri && /mongodb(?:\+srv)?:\/\//.test(uri) && !/localhost|127\.0\.0\.1/.test(uri) }));
  await inspect('local', 'mongodb://127.0.0.1:27017/nextplay');
  if (uri && !/localhost|127\.0\.0\.1/.test(uri)) await inspect('destination', uri);
})();
