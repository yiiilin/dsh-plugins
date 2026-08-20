import type { Service } from "@deepseek-ai/cordis";

export const name: "auth-webserver";

export class AuthWebServer extends Service {
  static Config: object;
  readonly port: number;
  readonly host: string;
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (req: any, res: any) => unknown;
  }): () => void;
  registerUpgrade(route: {
    path: string;
    handler: (req: any, socket: any, head: Buffer) => unknown;
  }): () => void;
  registerFallback(handler: (req: any, res: any) => unknown): () => void;
  tapIndex(transform: (html: string) => string): () => void;
  applyIndexTaps(html: string): string;
}

export default AuthWebServer;
