import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

export function collectorPhotoBuffer(value: string) {
  if (value.length > 600000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BadRequestException('Foto inválida. Escolha outra imagem.');
  const encoded = value.slice('data:image/jpeg;base64,'.length);
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.toString('base64') !== encoded || buffer.length < 4 || buffer[0] !== 255 || buffer[1] !== 216 || buffer[buffer.length - 2] !== 255 || buffer[buffer.length - 1] !== 217) throw new BadRequestException('Foto inválida. Escolha outra imagem.');
  return buffer;
}

@Injectable()
export class CollectorPhotoStorage {
  private readonly logger = new Logger(CollectorPhotoStorage.name);
  private client?: S3Client;
  private readonly bucket = process.env.S3_BUCKET || 'nextplay-ij';
  private s3() {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!region) throw new ServiceUnavailableException('Configure AWS_REGION para salvar fotos da coleção.');
    return this.client ??= new S3Client({ region, maxAttempts: 2 });
  }
  async upload(owner: string, image: Buffer) {
    // As chaves são geradas pelo servidor, separadas dos avatares e nunca aceitas do cliente.
    const key = `uploads/collector/${owner}/${randomUUID()}.jpg`;
    try {
      await this.s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: image, ContentType: 'image/jpeg', CacheControl: 'private, max-age=300', ServerSideEncryption: 'AES256' }), { abortSignal: AbortSignal.timeout(10000) });
      return key;
    } catch { throw new ServiceUnavailableException('Não foi possível salvar a foto da coleção no S3.'); }
  }
  async signedUrl(key: string) {
    try { return await getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 300 }); }
    catch { throw new ServiceUnavailableException('Não foi possível carregar a foto da coleção.'); }
  }
  async remove(key: string) {
    try { await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) }); }
    catch { this.logger.warn('Falha ao limpar foto da coleção no S3; limpeza posterior necessária.'); }
  }
}
