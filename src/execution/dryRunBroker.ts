import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { QuoteIntent } from "../types.js";

export interface OrderReceipt {
  id: string;
  status: "dry_run_accepted";
  quote: QuoteIntent;
}

export class DryRunBroker {
  constructor(private readonly outputPath: string) {}

  async placeMany(quotes: QuoteIntent[]): Promise<OrderReceipt[]> {
    await mkdir(dirname(this.outputPath), { recursive: true });
    const receipts = quotes.map((quote, index) => ({
      id: `dry-${Date.now()}-${index}`,
      status: "dry_run_accepted" as const,
      quote
    }));

    for (const receipt of receipts) {
      await appendFile(this.outputPath, JSON.stringify({ ts: new Date().toISOString(), ...receipt }) + "\n");
    }

    return receipts;
  }
}
