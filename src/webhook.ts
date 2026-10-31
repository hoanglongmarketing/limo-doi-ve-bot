import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { unwrapUpdate, type Bot } from "./bot.js";
import type { ZaloBotClient } from "./zalo.js";

function secretMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startWebhook(
  client: ZaloBotClient,
  bot: Bot,
  opts: { url: string; secret: string; port: number },
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers["x-bot-api-secret-token"];
    if (!secretMatches(Array.isArray(header) ? header[0] : header, opts.secret)) {
      res.writeHead(403).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // Trả 200 ngay để Zalo không gửi lại, xử lý ở phía sau.
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      try {
        bot.handleUpdate(unwrapUpdate(JSON.parse(body))).catch((err) => console.error("Lỗi xử lý tin:", err));
      } catch (err) {
        console.error("Webhook nhận dữ liệu không hợp lệ:", err);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  await client.setWebhook(opts.url, opts.secret);
  console.log(`Webhook đang chạy ở cổng ${opts.port}, đã đăng ký ${opts.url}`);
  return server;
}
