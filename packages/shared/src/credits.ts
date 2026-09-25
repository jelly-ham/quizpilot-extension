/** A credit pack as the backend sells it (GET /v1/billing/packs). */
export interface CreditPack {
  id: string;
  priceCents: number;
  currency: 'usd';
  credits: number;
}
