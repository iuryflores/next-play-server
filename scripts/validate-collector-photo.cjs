// Smoke test explícito: cria um objeto temporário no S3 e sempre tenta removê-lo.
// Não consulta MongoDB, não altera exemplares e não imprime URL assinada ou credenciais.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CollectorPhotoStorage } = require('../dist/collector/collector-photo-storage');
(async()=>{
  const storage = new CollectorPhotoStorage();
  let key;
  try {
    const bytes = Buffer.from([255,216,255,217]);
    key = await storage.upload('smoke-test-'+randomUUID(),bytes);
    const url = await storage.signedUrl(key);
    const response = await fetch(url,{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    await storage.remove(key);
    const removed = await fetch(url,{signal:AbortSignal.timeout(15000)});
    assert.ok([403,404].includes(removed.status),'objeto temporário deve ficar indisponível após remoção');
    key = undefined;
    console.log('S3: upload privado, URL assinada, leitura e remoção de objeto temporário validados.');
  } finally { if(key)await storage.remove(key); }
})().catch(error=>{console.error('Falha no teste S3:',error.name);process.exitCode=1;});
