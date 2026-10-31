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
        await client.setWebhook(`${url.origin}/webhook`, secret);
        return json({ ok: true, bot: bot.display_name, webhook: `${url.origin}/webhook` });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("x-bot-api-secret-token") !== secret) return json({ ok: false }, 403);
      const body = await request.text();
      const stub = env.BOT.get(env.BOT.idFromName("main"));
      // Trả lời Zalo ngay, xử lý tin ở phía sau.
      ctx.waitUntil(
        stub.fetch("https://bot/update", { method: "POST", body }).catch((err) => console.error("Lỗi xử lý tin:", err)),
      );
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

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
    const bot = await this.load();
    await bot.handleUpdate(unwrapUpdate(await request.json()));
    await bot.flush();
    return new Response("ok");
  }
}
