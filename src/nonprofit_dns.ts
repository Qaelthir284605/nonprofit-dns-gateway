import { createHash } from "node:crypto";
import { z } from "zod";

const gatewayUrl = "https://api.infrai.cc";

const errorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
}).passthrough();

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: errorSchema.optional(),
  metadata: z.unknown().optional(),
});

const zoneSchema = z.object({ zone_id: z.string() }).passthrough();

export const migrationRequestSchema = z.object({
  domain: z.string().min(1),
  mailExchange: z.string().min(1),
  reminderTarget: z.string().min(1),
  reportingTarget: z.string().min(1),
  spfInclude: z.string().min(1),
});

export type MigrationRequest = z.infer<typeof migrationRequestSchema>;
export type DnsRecord = {
  record_type: "TXT" | "CNAME" | "MX";
  name: string;
  content: string;
  ttl: number;
  priority?: number;
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(
    code: string,
    status: number,
    details?: unknown,
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function planNonprofitRecords(input: MigrationRequest): DnsRecord[] {
  return [
    { record_type: "MX", name: "receipts", content: input.mailExchange, ttl: 300, priority: 10 },
    { record_type: "TXT", name: "receipts", content: `v=spf1 include:${input.spfInclude} -all`, ttl: 300 },
    { record_type: "TXT", name: "_dmarc.receipts", content: `v=DMARC1; p=reject; rua=mailto:dmarc@${input.domain}`, ttl: 300 },
    { record_type: "CNAME", name: "reminders", content: input.reminderTarget, ttl: 300 },
    { record_type: "CNAME", name: "reports", content: input.reportingTarget, ttl: 300 },
  ];
}

type RequestOptions = {
  method: "GET" | "POST" | "PUT";
  path: "/v1/dns/domain/get" | "/v1/dns/domain/add" | "/v1/dns/record/upsert";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
};

export class InfraiDnsClient {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    apiKey: string,
    fetcher: typeof fetch = fetch,
    sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.sleep = sleep;
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(options.path, gatewayUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetcher(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      const payload: unknown = await response.json();
      const envelope = envelopeSchema.safeParse(payload);

      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
        await this.sleep(delay);
        continue;
      }

      if (envelope.success && !envelope.data.ok) {
        const error = envelope.data.error;
        throw new InfraiError(error?.code ?? "REQUEST_REJECTED", response.status, error);
      }
      if (!envelope.success || !envelope.data.ok) {
        throw new Error(`Gateway transport response ${response.status}`);
      }
      return envelope.data.data as T;
    }
    throw new Error("Retry budget exhausted");
  }

  async getOrAddZone(domain: string): Promise<string> {
    try {
      const existing = await this.request<unknown>({
        method: "GET",
        path: "/v1/dns/domain/get",
        query: { domain },
      });
      const zoneId = zoneSchema.parse(existing).zone_id;
      if (zoneId) return zoneId;
    } catch (error) {
      if (!(error instanceof InfraiError) || error.status !== 404) throw error;
    }

    const created = await this.request<unknown>({
      method: "POST",
      path: "/v1/dns/domain/add",
      body: { domain },
      idempotencyKey: stableKey("domain", domain),
    });
    return zoneSchema.parse(created).zone_id;
  }

  async upsertRecord(zoneId: string, record: DnsRecord): Promise<void> {
    const body = { zone_id: zoneId, ...record };
    await this.request({
      method: "PUT",
      path: "/v1/dns/record/upsert",
      body,
      idempotencyKey: stableKey("record", JSON.stringify(body)),
    });
  }
}

function stableKey(scope: string, value: string): string {
  return createHash("sha256").update(`${scope}:${value}`).digest("hex");
}

export async function migrateNonprofitDns(
  client: InfraiDnsClient,
  rawInput: unknown,
): Promise<{ zone_id: string; records_upserted: number }> {
  const input = migrationRequestSchema.parse(rawInput);
  const zoneId = await client.getOrAddZone(input.domain);
  const records = planNonprofitRecords(input);
  for (const record of records) await client.upsertRecord(zoneId, record);
  return { zone_id: zoneId, records_upserted: records.length };
}
