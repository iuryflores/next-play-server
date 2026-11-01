import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

@Injectable()
export class AvatarStorage {
  private readonly logger = new Logger(AvatarStorage.name);
  private client?: S3Client;
  private readonly bucket = process.env.S3_BUCKET || 'nextplay-ij';
  private s3() {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!region) throw new ServiceUnavailableException('Configure AWS_REGION para salvar fotos de perfil.');
    return this.client ??= new S3Client({ region, maxAttempts: 2 });
  }
  async upload(owner: string, image: Buffer) {
    const key = `uploads/avatars/${owner}/${randomUUID()}.jpg`;
    try {
      await this.s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: image, ContentType: 'image/jpeg', CacheControl: 'private, max-age=300', ServerSideEncryption: 'AES256' }), { abortSignal: AbortSignal.timeout(10000) });
      return key;
    } catch {
      throw new ServiceUnavailableException('Não foi possível salvar a foto no S3. Confira a configuração do servidor.');
    }
  }
  async signedUrl(key: string) {
    try { return await getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 300 }); }
    catch { throw new ServiceUnavailableException('Não foi possível carregar a foto de perfil.'); }
  }
  async remove(key: string) {
    try { await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) }); }
    catch { this.logger.warn('Falha ao limpar uma foto de perfil no S3; limpeza posterior necessária.'); }
  }
}
