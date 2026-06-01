import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "agenthub:is_public_route";

export const PublicRoute = () => SetMetadata(IS_PUBLIC_ROUTE, true);
