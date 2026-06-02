import { SetMetadata } from "@nestjs/common";

/** 公开路由的元数据 key，标记后跳过鉴权 */
export const IS_PUBLIC_ROUTE = "agenthub:is_public_route";

/** 装饰器：将路由标记为公开访问（无需登录） */
export const PublicRoute = () => SetMetadata(IS_PUBLIC_ROUTE, true);
