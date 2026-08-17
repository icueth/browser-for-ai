export interface RawCall {
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
  status?: number;
  resHeaders: Record<string, string>;
  resBody?: string;
  /** True when resBody is base64-encoded binary (CDP's `base64Encoded`), not text. */
  resBodyBase64?: boolean;
}

// source: "json:$.token" | "cookie:sid" | "header:location"
export interface FlowProducedValue {
  callIndex: number;
  source: string;
  value: string;
}

export interface FlowConsumedValue {
  location: "url-query" | "header" | "cookie" | "body-json";
  field: string;
  value: string;
}

export type FlowDepTransform = "exact" | "substring" | "urlenc" | "base64" | "jwt-claim";

export interface FlowDep {
  toCall: number;
  consumed: FlowConsumedValue;
  fromCall: number;
  source: string;
  varName: string;
  transform: FlowDepTransform;
  /** Dotted claim path within a decoded JWT payload (only set when transform is "jwt-claim"). */
  claimPath?: string;
  /** The full consumed string the producer value sits inside (only set when transform is "substring"). */
  container?: string;
}

export interface FlowCall {
  index: number;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
  reqJson?: unknown;
  status?: number;
  resHeaders: Record<string, string>;
  resBody?: string;
  resBodyBase64?: boolean;
  resJson?: unknown;
  produced: FlowProducedValue[];
  consumed: FlowConsumedValue[];
}

export interface FlowModel {
  calls: FlowCall[];
  deps: FlowDep[];
}
