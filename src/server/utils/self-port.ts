/** Bound-port holder: server-main records the Express listener's actual port
 * once bound so services can build loopback URLs (browser MCP over HTTP). */

let boundPort: number | undefined;

export function setBoundPort(port: number): void {
  boundPort = port;
}

export function getBoundPort(): number | undefined {
  return boundPort;
}

export function getSidecarBaseUrl(): string {
  const port = boundPort ?? Number(process.env.PORT ?? 3000);
  return `http://127.0.0.1:${port}`;
}
