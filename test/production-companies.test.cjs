const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {Types}=require('mongoose');
const database='nextplay_preferences_test_'+randomUUID().replaceAll('-','');process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;process.env.NODE_ENV='test';
const {createApp}=require('../dist/bootstrap');const {getConnectionToken}=require('@nestjs/mongoose');const {LibraryService}=require('../dist/library/library.module');
test('production companies count movies once per company and backfill only owned movies',async t=>{
 const app=await createApp();const db=app.get(getConnectionToken());t.after(async()=>{try{assert.match(database,/^nextplay_preferences_test_[a-f0-9]{32}$/);assert.equal(db.name,database);await db.dropDatabase();}finally{await app.close();}});
 const owner=new Types.ObjectId(),other=new Types.ObjectId(),first=new Types.ObjectId(),second=new Types.ObjectId();
 await db.collection('library_items').insertMany([
 {_id:first,ownerId:owner,title:'One',kind:'movie',status:'planned',catalogId:'tmdb:movie:1',catalogKey:'tmdb:movie:1'},
 {_id:second,ownerId:owner,title:'Two',kind:'movie',status:'completed',archived:true,productionCompanies:[{id:10,name:'Studio'},{id:10,name:'Studio'},{id:20,name:'Other'}]},
 {ownerId:owner,title:'Show',kind:'series',status:'active',productionCompanies:[{id:10,name:'Studio'}]},
 {ownerId:other,title:'Private',kind:'movie',status:'completed',productionCompanies:[{id:10,name:'Studio'}]}]);
 const service=app.get(LibraryService);
 const {CatalogService}=require('../dist/catalog/catalog.module');const catalog=app.get(CatalogService);let calls=0;
 catalog.detail=async()=>{calls++;return {productionCompanies:[{id:10,name:'Studio',logoUrl:'https://image.tmdb.org/t/p/w185/studio.png'}]};};
 await assert.rejects(()=>service.movieCompanies(other.toString(),first.toString()),e=>e.getStatus()===404);
 await service.movieCompanies(owner.toString(),first.toString());await service.movieCompanies(owner.toString(),first.toString());assert.equal(calls,1);
 const stats=await service.stats(owner.toString());assert.deepEqual(stats.preferences.productionCompanies,[{id:10,name:'Studio',logoUrl:'https://image.tmdb.org/t/p/w185/studio.png',count:2},{id:20,name:'Other',count:1}]);assert.equal(stats.preferences.moviesMissingCompanies,0);assert.deepEqual(stats.preferences.watchedMovieCompanies.map(c=>[c.id,c.count]),[[20,1],[10,1]]);assert.deepEqual(stats.preferences.watchedSeriesCompanies,[]);assert.deepEqual(stats.preferences.seriesProductionCompanies,[{id:10,name:'Studio',count:1}]);assert.equal(stats.preferences.seriesMissingCompanies,0);
 const show=await db.collection('library_items').findOne({ownerId:owner,kind:'series'});await db.collection('library_items').updateOne({_id:show._id},{$unset:{productionCompanies:''},$set:{catalogId:'tmdb:series:2'}});await service.movieCompanies(owner.toString(),show._id.toString());assert.equal(calls,2);await db.collection('episode_progress').insertMany([1,2].map(episode=>({itemId:show._id,season:1,episode})));const watched=await service.stats(owner.toString());assert.equal(watched.preferences.watchedSeriesCompanies[0].count,1);
 assert.deepEqual((await db.collection('catalog_titles').findOne({key:'tmdb:movie:1'}))?.productionCompanies,undefined);
 assert.equal((await service.list(owner.toString())).find(item=>item.id===first.toString()).productionCompanies[0].id,10);
 const upcoming=new Types.ObjectId();await db.collection('library_items').insertOne({_id:upcoming,ownerId:owner,title:'Upcoming',kind:'movie',status:'planned',year:String(new Date().getUTCFullYear()),catalogId:'tmdb:movie:99'});
 let releaseCalls=0;catalog.detail=async()=>{releaseCalls++;return {releaseDate:'2099-12-18',unreleased:true};};
 // A leitura da coleção não espera provedores nem preenche registros por efeito colateral.
 let collection=await service.list(owner.toString());assert.equal(collection.find(item=>item.id===upcoming.toString()).releaseDate,undefined);
 await service.list(owner.toString());assert.equal(releaseCalls,0);assert.equal((await db.collection('library_items').findOne({_id:upcoming})).status,'planned');

});
