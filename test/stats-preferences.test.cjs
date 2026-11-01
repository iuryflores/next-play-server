const {test}=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {Types}=require('mongoose');
const database='nextplay_preferences_test_'+randomUUID().replaceAll('-','');process.env.MONGODB_URI='mongodb://127.0.0.1:27017/'+database;process.env.NODE_ENV='test';
const {createApp}=require('../dist/bootstrap');const {getConnectionToken}=require('@nestjs/mongoose');const {LibraryService}=require('../dist/library/library.module');
test('personal preferences count distinct titles, episode feelings and production-scoped votes',async t=>{
 const app=await createApp();const db=app.get(getConnectionToken());t.after(async()=>{try{assert.match(database,/^nextplay_preferences_test_[a-f0-9]{32}$/);assert.equal(db.name,database);await db.dropDatabase();}finally{await app.close();}});
 const owner=new Types.ObjectId(),other=new Types.ObjectId(),series=new Types.ObjectId(),movie=new Types.ObjectId();
 await db.collection('library_items').insertMany([
 {_id:series,ownerId:owner,title:'Series',kind:'series',status:'active',archived:true,genres:['Drama','drama','Comédia'],catalogId:'tmdb:series:1'},
 {_id:movie,ownerId:owner,title:'Movie',kind:'movie',status:'completed',genres:['Drama'],favoriteCharacter:'Alex'},
 {ownerId:owner,title:'Game',kind:'game',status:'planned',genres:['RPG']},
 {ownerId:other,title:'Private',kind:'movie',status:'completed',genres:['Terror'],favoriteCharacter:'Private character'}]);
 await db.collection('episode_progress').insertMany([
 {itemId:series,season:1,episode:1,watchedAt:new Date(),feeling:'happy',favoriteCharacter:'Alex'},
 {itemId:series,season:1,episode:2,watchedAt:new Date(),feeling:'happy',favoriteCharacter:'alex'},
 {itemId:series,season:1,episode:3,watchedAt:new Date(),feeling:'scared'},
 {itemId:series,season:1,episode:4,watchedAt:new Date(),feeling:''}]);
 const service=app.get(LibraryService);let stats=await service.stats(owner.toString());
 assert.equal(stats.preferences.characters[0].count,2);assert.equal(stats.preferences.characters[0].itemId,series.toString());assert.equal(stats.preferences.characters.length,2);
 assert.equal(stats.preferences.addedGenres.find(g=>g.name==='Drama').count,2);assert.equal(stats.preferences.watchedGenres.find(g=>g.name==='Drama').count,2);assert.ok(!stats.preferences.watchedGenres.some(g=>g.name==='RPG'));
 assert.equal(stats.preferences.feelingSources.find(entry=>entry.feeling==='happy').count,2);assert.equal(stats.preferences.feelingSources.find(entry=>entry.feeling==='scared').count,1);assert.ok(stats.preferences.feelingSources.every(entry=>entry.itemId===series.toString()));
 assert.equal(stats.preferences.seriesFeelings[0].ratedEpisodes,3);assert.deepEqual(stats.preferences.seriesFeelings[0].feelings,[{feeling:'happy',count:2}]);assert.ok(!JSON.stringify(stats.preferences).includes('Private'));
 await db.collection('episode_progress').updateOne({itemId:series,episode:4},{$set:{feeling:'scared'}});stats=await service.stats(owner.toString());assert.equal(stats.preferences.seriesFeelings[0].feelings.length,2);
 const empty=await service.stats(new Types.ObjectId().toString());assert.deepEqual(empty.preferences,{watchedMovieCompanies:[],watchedSeriesCompanies:[],watchedMoviesMissingCompanies:0,watchedSeriesMissingCompanies:0,feelingSources:[],seriesProductionCompanies:[],seriesMissingCompanies:0,productionCompanies:[],moviesMissingCompanies:0,actors:[],unmatchedActorVotes:{},characters:[],addedGenres:[],watchedGenres:[],seriesFeelings:[]});
});
