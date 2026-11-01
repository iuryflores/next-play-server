const {test}=require('node:test');
const assert=require('node:assert/strict');
const {CollectorPhotoStorage,collectorPhotoBuffer}=require('../dist/collector/collector-photo-storage');

test('fotos de objetos usam prefixo separado, JPEG privado e criptografia no S3',async()=>{
  const storage=new CollectorPhotoStorage(), commands=[];
  storage.client={send:async command=>commands.push(command.input)};
  const region=process.env.AWS_REGION;process.env.AWS_REGION='us-east-1';
  try {
    const key=await storage.upload('test-owner',collectorPhotoBuffer('data:image/jpeg;base64,/9j/2Q=='));
    assert.match(key,/^uploads\/collector\/test-owner\/[\w-]+\.jpg$/);
    assert.equal(commands[0].Bucket,process.env.S3_BUCKET||'nextplay-ij');
    assert.equal(commands[0].ContentType,'image/jpeg');assert.equal(commands[0].ServerSideEncryption,'AES256');assert.equal(commands[0].ACL,undefined);
    await storage.remove(key);assert.equal(commands[1].Key,key);
  } finally {if(region===undefined)delete process.env.AWS_REGION;else process.env.AWS_REGION=region;}
});
test('validação rejeita URLs, SVG e base64 inválido antes do S3',()=>{
  for(const value of ['https://example.test/x.jpg','data:image/svg+xml;base64,PHN2Zz4=','data:image/jpeg;base64,YWJjZA==','data:image/jpeg;base64,/9j/2Q=','x'.repeat(600001)]) assert.throws(()=>collectorPhotoBuffer(value),{status:400});
});
