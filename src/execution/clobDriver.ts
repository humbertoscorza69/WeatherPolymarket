import {
  ApiKeyCreds,
  AssetType,
  ClobClient,
  createL2Headers,
  OrderSide,
  OrderType,
  Side as ClobSide,
  type BalanceAllowanceParams,
  type SignedOrder
} from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { Config } from "../config.js";
import { QuoteIntent, Side } from "../types.js";

const CHAIN_ID = 137;
const POST_ORDER = "/order";

export interface RawOrderPayload {
  deferExec: false;
  order: {
    salt: number;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    side: "BUY" | "SELL";
    signatureType: number;
    signature: string;
  };
  owner: string;
  orderType: OrderType;
  postOnly: boolean;
}

export interface PostOrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  errorMsg?: string;
  raw: unknown;
}

export interface ClobDriverDeps {
  client: ClobClient;
  signer: Wallet;
  creds: ApiKeyCreds;
  funderAddress: string;
  host?: string;
  fetchImpl?: typeof fetch;
}

export class ClobDriver {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: ClobDriverDeps) {
    this.host = deps.host ?? "https://clob.polymarket.com";
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async createSignedOrder(quote: QuoteIntent): Promise<SignedOrder> {
    return this.deps.client.createOrder(
      {
        tokenID: quote.tokenId,
        price: quote.price,
        size: quote.shares,
        side: toClobSide(quote.side)
      },
      { tickSize: "0.01", negRisk: true }
    );
  }

  async placeQuote(quote: QuoteIntent, postOnly = true): Promise<PostOrderResult> {
    const signed = await this.createSignedOrder(quote);
    return this.placePostOnlyOrder(signed, OrderType.GTC, postOnly);
  }

  async placePostOnlyOrder(
    signedOrder: SignedOrder,
    orderType: OrderType = OrderType.GTC,
    postOnly = true
  ): Promise<PostOrderResult> {
    const payload = buildRawOrderPayload(signedOrder, this.deps.creds.key, orderType, postOnly);
    return this.authenticatedPost(POST_ORDER, payload);
  }

  async authenticatedPost(path: string, payload: RawOrderPayload): Promise<PostOrderResult> {
    const body = JSON.stringify(payload);
    const headers = await createL2Headers(this.deps.signer, this.deps.creds, {
      method: "POST",
      requestPath: path,
      body
    });
    const response = await this.fetchImpl(`${this.host}${path}`, {
      method: "POST",
      headers: {
        ...stringifyHeaders(headers),
        "content-type": "application/json"
      },
      body
    });
    const raw = await readJson(response);
    if (!response.ok) {
      return {
        success: false,
        status: "rejected",
        errorMsg: extractError(raw) ?? `${response.status} ${response.statusText}`,
        raw
      };
    }
    return normalizePostOrderResult(raw);
  }

  getOrderBook(tokenId: string) {
    return this.deps.client.getOrderBook(tokenId);
  }

  getOpenOrders() {
    return this.deps.client.getOpenOrders();
  }

  cancelAll() {
    return this.deps.client.cancelAll();
  }

  cancelOrder(orderId: string) {
    return this.deps.client.cancelOrder({ orderID: orderId });
  }

  getBalanceAllowance(params: BalanceAllowanceParams) {
    return this.deps.client.getBalanceAllowance(params);
  }

  async fetchTokenBalance(tokenId: string): Promise<number> {
    const result = await this.deps.client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    const raw = (result as { balance?: string } | null)?.balance ?? "0";
    return parseFloat(raw);
  }
}

export function buildRawOrderPayload(
  signedOrder: SignedOrder,
  owner: string,
  orderType: OrderType = OrderType.GTC,
  postOnly = true
): RawOrderPayload {
  if (postOnly && orderType !== OrderType.GTC && orderType !== OrderType.GTD) {
    throw new Error("postOnly orders must be GTC or GTD");
  }
  return {
    deferExec: false,
    order: {
      salt: Number.parseInt(signedOrder.salt, 10),
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      taker: signedOrder.taker,
      tokenId: signedOrder.tokenId,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
      expiration: signedOrder.expiration,
      nonce: signedOrder.nonce,
      feeRateBps: signedOrder.feeRateBps,
      side: signedOrder.side === OrderSide.BUY ? "BUY" : "SELL",
      signatureType: signedOrder.signatureType,
      signature: signedOrder.signature
    },
    owner,
    orderType,
    postOnly
  };
}

export function createClobDriverFromConfig(config: Config): ClobDriver {
  const missing = [
    ["POLYMARKET_PRIVATE_KEY", config.polymarketPrivateKey],
    ["POLYMARKET_API_KEY", config.polymarketApiKey],
    ["POLYMARKET_API_SECRET", config.polymarketApiSecret],
    ["POLYMARKET_API_PASSPHRASE", config.polymarketApiPassphrase],
    ["POLYMARKET_FUNDER_ADDRESS", config.polymarketFunderAddress]
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    throw new Error(`Missing Polymarket credentials: ${missing.map(([name]) => name).join(", ")}`);
  }

  const signer = new Wallet(config.polymarketPrivateKey as string);
  const creds: ApiKeyCreds = {
    key: config.polymarketApiKey as string,
    secret: config.polymarketApiSecret as string,
    passphrase: config.polymarketApiPassphrase as string
  };
  const client = new ClobClient(
    config.clobHost,
    CHAIN_ID,
    signer,
    creds,
    config.polymarketSignatureType,
    config.polymarketFunderAddress
  );

  return new ClobDriver({
    client,
    signer,
    creds,
    funderAddress: config.polymarketFunderAddress as string,
    host: config.clobHost
  });
}

function toClobSide(side: Side): ClobSide {
  return side === "BUY" ? ClobSide.BUY : ClobSide.SELL;
}

function stringifyHeaders(headers: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function extractError(raw: unknown): string | undefined {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    return String(record.errorMsg ?? record.error ?? record.message ?? "") || undefined;
  }
  return undefined;
}

function normalizePostOrderResult(raw: unknown): PostOrderResult {
  if (!raw || typeof raw !== "object") {
    return { success: false, status: "unknown", raw };
  }
  const record = raw as Record<string, unknown>;
  return {
    success: record.success === true || record.status === "live",
    orderId: typeof record.orderId === "string" ? record.orderId : String(record.orderID ?? ""),
    status: typeof record.status === "string" ? record.status : undefined,
    errorMsg: typeof record.errorMsg === "string" ? record.errorMsg : undefined,
    raw
  };
}
