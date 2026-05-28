declare module "ali-oss" {
  export default class OSS {
    constructor(options: Record<string, unknown>);
    put(key: string, data: Buffer): Promise<{ name?: string; url?: string }>;
    signatureUrl(key: string, options?: Record<string, unknown>): string;
  }
}
