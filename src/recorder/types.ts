export interface NetEntry {
  id: string; seq: number;
  method: string; url: string; resourceType: string;
  requestHeaders: Record<string, string>; hasPostData: boolean;
  status?: number; statusText?: string; mimeType?: string;
  responseHeaders?: Record<string, string>;
  fromCache?: boolean;
  startTs: number; endTs?: number; encodedDataLength?: number;
  // Real CDP timing (optional; synthetic unit events omit them). wallStart is epoch
  // seconds (requestWillBeSent.wallTime); tsStart/tsEnd are the monotonic CDP
  // `timestamp` (seconds) at send and finish/fail; durationMs is derived from both.
  wallStart?: number; tsStart?: number; tsEnd?: number; durationMs?: number;
  finished: boolean; failed: boolean; errorText?: string; blockedReason?: string;
  initiatorType?: string;
  // Prior hops when this requestId was redirected one or more times before landing
  // on the final url/method above. In order: earliest hop first.
  redirects?: { url: string; status: number }[];
}
export interface WsFrame { seq: number; dir: "sent" | "recv"; opcode: number; payload: string; ts: number }
export interface WsEntry { id: string; seq: number; url: string; frames: WsFrame[]; closed: boolean }
export interface NetFilter { urlIncludes?: string; method?: string; type?: string; status?: number; onlyXhr?: boolean }
export interface ConsoleEntry { seq: number; level: string; text: string; count: number; source: string; url?: string; line?: number; stack?: string }
