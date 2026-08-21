export const name: "auth-webserver";

export const Config: object;

export function apply(ctx: any, config: Partial<{
  port: number;
  targetHost: string;
  targetPort: number;
  addresses: string[];
  username: string;
  password: string;
  realm: string;
}>): void;