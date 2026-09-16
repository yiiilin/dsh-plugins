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
  allowRemoteSettings: boolean;
  allowInsecureRemoteSettings: boolean;
  allowInsecureSettingsEditor: boolean;
  passkeyRpName: string;
  passkeyRpId: string;
  /** Ceiling on a browser session that activity cannot extend; 0 imposes none. */
  sessionMaxAgeSeconds: number;
  /** Idle lifetime of a browser session; every accepted request slides it. */
  sessionIdleTimeoutSeconds: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
  maxLoginAttemptEntries: number;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
}>): Promise<void>;
