/** Recorded-fixture fetch mock: route by URL, record every call for assertions. */

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  method: string;
  body: unknown; // parsed JSON body when present
  headers: Record<string, string>;
}

type Handler = (url: string, init?: RequestInit) => Response | null | Promise<Response | null>;

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class MockFetch {
  calls: RecordedCall[] = [];
  private handlers: Handler[] = [];
  private original: typeof fetch | undefined;

  route(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  callsTo(substr: string): RecordedCall[] {
    return this.calls.filter((c) => c.url.includes(substr));
  }

  install(): this {
    this.original = globalThis.fetch;
    const self = this;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let body: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
      }
      self.calls.push({ url, init, method: init?.method ?? "GET", body, headers });
      for (const h of self.handlers) {
        const res = await h(url, init);
        if (res) return res;
      }
      return new Response(`mock-fetch: unhandled ${url}`, { status: 599 });
    }) as typeof fetch;
    return this;
  }

  restore(): void {
    if (this.original) globalThis.fetch = this.original;
  }
}
