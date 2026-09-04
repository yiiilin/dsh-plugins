export const name: "auth-webserver";

export const Config: object;

export function apply(ctx: any, config?: Partial<{
  port: number;
  targetHost: string;
  targetPort: number;
  addresses: string[];
  username: string;
  password: string;
  realm: string;
  twoFactorEnabled: boolean;
  requireTwoFactor: boolean;
  twoFactorSecret: string;
  mobileMode?: "auto" | "off";
  mobileBreakpoint?: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustedProxyAddresses: string[];
  requireHttps: boolean;
  allowInsecureSettingsEditor: boolean;
  passkeyRpName: string;
  passkeyRpId: string;
  sessionMaxAgeSeconds: number;
  sessionIdleTimeoutSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
  maxLoginAttemptEntries: number;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
}>): Promise<void>;
