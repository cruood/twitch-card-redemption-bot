import { createServer, type Server } from "node:http";

export interface ProcessHealthServer {
  readonly port: number;
  markStopping(): void;
  close(): Promise<void>;
}

export async function startHealthServer(
  service: string,
  port: number | undefined,
  host = "0.0.0.0"
): Promise<ProcessHealthServer | undefined> {
  if (port === undefined) return undefined;

  let stopping = false;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/readyz")) {
      response.writeHead(404).end();
      return;
    }

    const status = stopping ? 503 : 200;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ service, status: stopping ? "stopping" : "ok" }));
  });
  await listen(server, port, host);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Health server did not bind a TCP port");

  return {
    port: address.port,
    markStopping: () => {
      stopping = true;
    },
    close: () => close(server)
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
