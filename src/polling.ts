import type { Bot } from "./bot.js";
import type { ZaloBotClient } from "./zalo.js";

export async function startPolling(client: ZaloBotClient, bot: Bot, signal: AbortSignal): Promise<void> {
  // getUpdates không dùng được khi đang có webhook, nên xoá webhook trước.
  await client.deleteWebhook().catch(() => undefined);
  console.log("Đang lắng nghe tin nhắn bằng long polling...");

  let backoffMs = 1000;
  while (!signal.aborted) {
    try {
      const updates = await client.getUpdates(30);
      backoffMs = 1000;
      for (const update of updates) {
        await bot.handleUpdate(update).catch((err) => console.error("Lỗi xử lý tin:", err));
      }
    } catch (err) {
      if (signal.aborted) break;
      console.error(`Lỗi getUpdates, thử lại sau ${backoffMs / 1000}s:`, err);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}
