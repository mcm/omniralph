export interface CartLine {
  sku: string;
  unitPriceCents: number;
  quantity: number;
}

export interface Discount {
  code: string;
  /** 0–100. */
  percent: number;
  /** Only lines with these SKUs are discounted; empty = every line. */
  skus: string[];
}
