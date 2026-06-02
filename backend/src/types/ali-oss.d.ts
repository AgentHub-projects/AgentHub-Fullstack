/** 阿里云 OSS SDK 类型声明 */
declare module "ali-oss" {
  /** 阿里云 OSS 客户端类 */
  export default class OSS {
    constructor(options: Record<string, unknown>);
    /** 上传文件到 OSS */
    put(key: string, data: Buffer): Promise<{ name?: string; url?: string }>;
    /** 生成带签名的访问 URL */
    signatureUrl(key: string, options?: Record<string, unknown>): string;
  }
}
