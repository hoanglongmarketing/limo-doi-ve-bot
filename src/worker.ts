// Bản chạy trên Cloudflare Workers: Zalo gửi tin tới /webhook, một Durable Object
// xử lý lần lượt từng tin và giữ dữ liệu đổi vé. Cài đặt: docs/cloudflare.md.
import { createBot, unwrapUpdate, type Bot, type BotEnv } from "./bot.js";
import { parseStored, RequestStore, type StoredRequest } from "./exchange/store.js";
import { ZaloBotClient } from "./zalo.js";

// Kiểu tối giản của Cloudflare runtime, đủ dùng cho file này.
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface ScheduledController {
  scheduledTime: number;
}

type Env = { BOT: DurableObjectNamespace } & Record<string, unknown>;

/** Chỉ lấy các biến dạng chuỗi (Variables, Secrets) để đưa cho bot. */
function botEnv(env: Env): BotEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as BotEnv;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const vars = botEnv(env);
    const secret = vars.WEBHOOK_SECRET;
    if (!vars.ZALO_BOT_TOKEN || !secret) return json({ ok: false, error: "Thiếu ZALO_BOT_TOKEN hoặc WEBHOOK_SECRET" }, 500);

    if (url.pathname === "/health") return new Response("ok");

    // Mở một lần trên trình duyệt để đăng ký webhook với Zalo: /setup?secret=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== secret) return json({ ok: false, error: "Sai secret" }, 403);
      const client = new ZaloBotClient(vars.ZALO_BOT_TOKEN);
      try {
        const bot = await client.getMe();
        if (pollingMode(vars)) {
          await client.deleteWebhook().catch(() => undefined);
          return json({ ok: true, bot: bot.display_name, mode: "polling (Cloudflare hỏi Zalo mỗi phút)" });
        }
        await client.setWebhook(`${url.origin}/webhook/${secret}`, secret);
        const info = await client.call<{ url?: string }>("getWebhookInfo");
        return json({ ok: true, bot: bot.display_name, webhook: info.url?.replace(secret, "<secret>") });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    const stub = env.BOT.get(env.BOT.idFromName("main"));

    // Xem 20 lần Zalo gọi gần nhất và lỗi nếu có: /debug?secret=<WEBHOOK_SECRET>
    if (url.pathname === "/debug") {
      if (url.searchParams.get("secret") !== secret) return json({ ok: false, error: "Sai secret" }, 403);
      return stub.fetch("https://bot/debug");
    }

    // Zalo gọi /webhook (secret trong header) hoặc /webhook/<secret> (secret trong đường dẫn).
    if (url.pathname.startsWith("/webhook") && request.method === "POST") {
      const pathSecret = url.pathname.split("/")[2];
      const headerSecret =
        request.headers.get("x-bot-api-secret-token") ?? request.headers.get("x-zalo-bot-api-secret-token");
      const authorized = headerSecret === secret || pathSecret === secret;
      const body = await request.text();
      const hit = {
        at: new Date().toISOString(),
        path: url.pathname.replace(secret, "<secret>"),
        headers: [...request.headers.keys()],
        authorized,
        body: body.slice(0, 500),
      };
      // Trả lời Zalo ngay, ghi nhận và xử lý tin ở phía sau.
      ctx.waitUntil(
        stub
          .fetch("https://bot/update", { method: "POST", body: JSON.stringify({ hit, body: authorized ? body : undefined }) })
          .catch((err) => console.error("Lỗi xử lý tin:", err)),
      );
      return authorized ? json({ ok: true }) : json({ ok: false }, 403);
    }

    return new Response("Not found", { status: 404 });
  },

  // Chế độ polling: Cloudflare chạy hàm này mỗi phút (wrangler.jsonc > triggers),
  // hỏi Zalo liên tục khoảng 50 giây rồi nhường cho lượt sau.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const vars = botEnv(env);
    if (!pollingMode(vars) || !vars.ZALO_BOT_TOKEN) return;
    const client = new ZaloBotClient(vars.ZALO_BOT_TOKEN);
    const stub = env.BOT.get(env.BOT.idFromName("main"));
    const deadline = controller.scheduledTime + 50_000;
    const run = { at: new Date().toISOString(), polls: 0, updates: 0, error: undefined as string | undefined };

    try {
      while (Date.now() < deadline - 5_000) {
        const wait = Math.min(25, Math.floor((deadline - Date.now()) / 1000));
        const updates = await client.getUpdates(wait);
        run.polls++;
        run.updates += updates.length;
        for (const update of updates) {
          const hit = { at: new Date().toISOString(), path: "polling", authorized: true, body: JSON.stringify(update).slice(0, 500) };
          await stub.fetch("https://bot/update", { method: "POST", body: JSON.stringify({ hit, body: JSON.stringify(update) }) });
        }
      }
    } catch (err) {
      run.error = String(err);
      console.error("Lỗi polling:", err);
    }
    // Ghi lại lượt chạy để xem trên /debug.
    await stub.fetch("https://bot/cron", { method: "POST", body: JSON.stringify(run) });
  },
};

/** BOT_MODE=webhook thì Zalo gọi /webhook; mặc định Cloudflare tự hỏi Zalo (polling). */
function pollingMode(vars: BotEnv): boolean {
  return (vars.BOT_MODE ?? "polling") !== "webhook";
}

/** Một bản duy nhất ("main") giữ toàn bộ yêu cầu đổi vé, mỗi yêu cầu một khoá "req:YCxxx". */
export class BotState {
  private bot?: Promise<Bot>;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private load(): Promise<Bot> {
    this.bot ??= (async () => {
      const storage = this.state.storage;
      const saved = await storage.list<string>({ prefix: "req:" });
      const items = [...saved.values()]
        .map((v) => parseStored<StoredRequest>(v))
        .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
      const seq = (await storage.get<number>("seq")) ?? 0;
      const store = new RequestStore({ seq, items }, (s, changed) => {
        void storage.put(`req:${changed.id}`, JSON.stringify(changed));
        void storage.put("seq", s.lastSeq);
      });
      const vars = botEnv(this.env);
      const client = new ZaloBotClient(vars.ZALO_BOT_TOKEN!);
      return createBot(client, await client.getMe(), store, vars);
    })().catch((err) => {
      this.bot = undefined;
      throw err;
    });
    return this.bot;
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage;
    const path = new URL(request.url).pathname;
    if (path === "/debug") {
      return json({
        cronRuns: (await storage.get<unknown[]>("debug:cron")) ?? [],
        hits: (await storage.get<unknown[]>("debug:hits")) ?? [],
      });
    }
    if (path === "/cron") {
      const runs = (await storage.get<unknown[]>("debug:cron")) ?? [];
      await storage.put("debug:cron", [await request.json(), ...runs].slice(0, 10));
      return new Response("ok");
    }

    const { hit, body } = (await request.json()) as { hit: Record<string, unknown>; body?: string };
    try {
      if (body) {
        const bot = await this.load();
        await bot.handleUpdate(unwrapUpdate(JSON.parse(body)));
        await bot.flush();
      }
    } catch (err) {
      hit.error = String(err);
      console.error("Lỗi xử lý tin:", err);
    }
    const hits = (await storage.get<unknown[]>("debug:hits")) ?? [];
    await storage.put("debug:hits", [hit, ...hits].slice(0, 20));
    return new Response("ok");
  }
}
