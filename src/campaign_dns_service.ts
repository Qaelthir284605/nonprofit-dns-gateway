import { createServer } from "node:http";
import { InfraiDnsClient, InfraiError, migrateNonprofitDns } from "./nonprofit_dns.ts";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

const client = new InfraiDnsClient(apiKey);
const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/migrations") {
    sendJson(response, 404, { error: "Route not found" });
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await migrateNonprofitDns(client, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof InfraiError) {
      sendJson(response, error.status >= 400 && error.status < 500 ? error.status : 502, {
        error: error.code,
      });
      return;
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError")) {
      sendJson(response, 400, { error: "Invalid migration request" });
      return;
    }
    sendJson(response, 502, { error: "Migration request could not be completed" });
  }
});

server.listen(port, () => console.log(`Campaign DNS service listening on http://localhost:${port}`));

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
