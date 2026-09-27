import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * OBJECT STORAGE — one small interface over S3 (SeaweedFS locally, cloud S3 deployed; see
 * TECHSTACK §11.3 for why MinIO is out). Module 5 distributes signed policy bundles through it;
 * Modules 6 and 7 store content-addressed blobs and WORM evidence in it.
 *
 * Deliberately narrow: put, get, ensure a bucket. Everything a caller needs to trust about an
 * object (a signature, a digest) travels inside the object, not in storage metadata.
 */

export interface ObjectStore {
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  /** The object's bytes, or null when there is none. */
  get(key: string): Promise<Buffer | null>;
  ensureBucket(): Promise<void>;
}

export interface S3Options {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  /** SeaweedFS (and MinIO-compatible stores) address buckets by path, not by host. */
  forcePathStyle?: boolean;
}

export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;

  constructor(private readonly opts: S3Options) {
    this.s3 = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
      ...(opts.accessKeyId && opts.secretAccessKey ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } } : {}),
    });
  }

  get bucket(): string {
    return this.opts.bucket;
  }

  async put(key: string, body: Buffer | string, contentType = 'application/octet-stream'): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.opts.bucket })).catch((e: { name?: string }) => {
        if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
      });
    }
  }
}

/** In memory: unit tests, and nothing else. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer | string, contentType = 'application/octet-stream'): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }
  async get(key: string): Promise<Buffer | null> {
    return this.objects.get(key)?.body ?? null;
  }
  async ensureBucket(): Promise<void> {}
}

/** From the environment (.env.example: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). */
export function s3FromEnv(env: NodeJS.ProcessEnv, bucket: string): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: env['S3_ENDPOINT'],
    region: env['S3_REGION'] ?? 'us-east-1',
    bucket,
    accessKeyId: env['S3_ACCESS_KEY_ID'],
    secretAccessKey: env['S3_SECRET_ACCESS_KEY'],
  });
}
