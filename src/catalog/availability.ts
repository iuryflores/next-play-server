export function storeLink(raw:unknown):{name:string;url:string}|null{
  if(typeof raw!=='string'||raw.length>2000)return null;
  try{
    const url=new URL(raw);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)return null;
    const stores:[string,string][]=[['store.steampowered.com','Steam'],['store.epicgames.com','Epic Games'],['epicgames.com','Epic Games'],['gog.com','GOG'],['store.playstation.com','PlayStation Store'],['nintendo.com','Nintendo'],['xbox.com','Xbox'],['microsoft.com','Microsoft Store'],['apps.apple.com','App Store'],['play.google.com','Google Play'],['itch.io','itch.io'],['store.ubisoft.com','Ubisoft Store'],['battle.net','Battle.net'],['ea.com','EA']];
    const store=stores.find(([host])=>url.hostname===host||url.hostname.endsWith('.'+host));
    if(!store)return null;
    // O link precisa vir do catálogo e pertencer à loja; nunca seguimos redirecionamentos no servidor.
    url.protocol='https:';url.hash='';return {name:store[1],url:url.toString()};
  }catch{return null;}
}
export function tmdbWatchLink(raw:unknown):string|null{
  if(typeof raw!=='string')return null;
  try{const url=new URL(raw);if(url.protocol!=='https:'||!['www.themoviedb.org','themoviedb.org'].includes(url.hostname)||url.username||url.password||url.port||!/^\/(movie|tv)\/[1-9]\d*[^/]*\/watch\/?$/.test(url.pathname))return null;return url.toString();}catch{return null;}
}
