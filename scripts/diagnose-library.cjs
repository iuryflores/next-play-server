const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { LibraryService } = require('../dist/library/library.module');
(async () => { let app; try { app = await createApp(); const db = app.get(getConnectionToken()); const user = await db.collection('users').findOne({}, { projection: { _id: 1 } }); const start = Date.now(); const items = await app.get(LibraryService).list(user._id.toString()); console.log(JSON.stringify({ success: true, items: items.length, elapsedMs: Date.now() - start })); } catch(e) { console.error(JSON.stringify({ type: e.name, code: e.code, frames: e.stack?.split('\n').slice(1, 5) })); process.exitCode = 1; } finally { if(app) await app.close(); } })();
