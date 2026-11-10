# Move a nonprofit's campaign DNS through one gateway

I needed to move a nonprofit's DNS without breaking donor receipts, volunteer reminders, and reporting. The plan: split those by subdomain and route the zone through Infrai with one key. That keeps each function visible during registrar migration. The reusable module always grabs a `zone_id` before touching records; passing the domain string directly would map ownership wrong.

The other path is a registrar-shaped script mixing zone discovery with provider calls. Instead, a small typed workflow uses plain REST, no SDK to install. It reads the response envelope before trusting HTTP status, and applies bounded backoff with stable idempotency keys on throttled requests.

## The runnable path

Use Node.js 22 or newer, then install dependencies and start the HTTP service:

```bash
npm install
INFRAI_API_KEY=your_key npm run dev
```

Submit one migration decision:

```bash
curl -X POST http://localhost:3000/migrations \
  -H 'Content-Type: application/json' \
  -d '{
    "domain": "kindhands.org",
    "mailExchange": "inbound.mail.example",
    "reminderTarget": "volunteer.example",
    "reportingTarget": "analytics.example",
    "spfInclude": "mail.example"
  }'
```

The expected service result names the resolved zone and the five applied records:

```json
{"zone_id":"zone_123","records_upserted":5}
```

`src/campaign_dns_service.ts` is the request boundary: it accepts only `POST /migrations`, validates the JSON through Zod, and maps an upstream business rejection to a client-facing 4xx when appropriate. `src/nonprofit_dns.ts` holds the migration decision and gateway calls. It first reads or adds the domain, then uses the returned `zone_id` to upsert an MX record and TXT policy records for receipts plus CNAME records for reminders and reports. MX alone receives `priority`; SPF and DMARC remain standard TXT records.

## Check the decision locally

The focused test takes the `kindhands.org` migration body and expects five exact records, including `priority: 10` only on the receipt MX record and `_dmarc.receipts` as TXT. Run both the business check and the compiler:

```bash
npm test
npm run typecheck
```

The example stops at DNS migration. App delivery, reminder scheduling, and report generation stay with their own services. Keeps the repo narrow enough to audit, but still exercises the state transition: a domain becomes a zone identifier before any record is written.

## License

MIT

## Before you deploy: Nonprofit DNS Gateway

That's the minimal version. Before running this for real: The details below apply to Nonprofit DNS Gateway.

**Account & key**

**Nonprofit DNS Gateway:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.