import assert from "node:assert/strict";
import test from "node:test";
import { InfraiDnsClient, planNonprofitRecords } from "../src/nonprofit_dns.ts";

test("plans isolated DNS identities for receipts, reminders, and reports", () => {
  const records = planNonprofitRecords({
    domain: "kindhands.org",
    mailExchange: "inbound.mail.example",
    reminderTarget: "volunteer.example",
    reportingTarget: "analytics.example",
    spfInclude: "mail.example",
  });

  assert.deepEqual(records, [
    { record_type: "MX", name: "receipts", content: "inbound.mail.example", ttl: 300, priority: 10 },
    { record_type: "TXT", name: "receipts", content: "v=spf1 include:mail.example -all", ttl: 300 },
    { record_type: "TXT", name: "_dmarc.receipts", content: "v=DMARC1; p=reject; rua=mailto:dmarc@kindhands.org", ttl: 300 },
    { record_type: "CNAME", name: "reminders", content: "volunteer.example", ttl: 300 },
    { record_type: "CNAME", name: "reports", content: "analytics.example", ttl: 300 },
  ]);
});

test("adds a domain when lookup returns an empty zone id", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url: input.toString() });
    const data = requests.length === 1 ? { zone_id: "" } : { zone_id: "zone_123" };
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = new InfraiDnsClient("test-key", fetcher as typeof fetch);
  assert.equal(await client.getOrAddZone("kindhands.org"), "zone_123");
  assert.deepEqual(requests.map(({ method, url }) => ({ method, path: new URL(url).pathname })), [
    { method: "GET", path: "/v1/dns/domain/get" },
    { method: "POST", path: "/v1/dns/domain/add" },
  ]);
});
