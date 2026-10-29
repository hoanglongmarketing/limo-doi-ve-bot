import { loadConfig } from "./config.js";
import { startPolling } from "./polling.js";
import { startWebhook } from "./webhook.js";
import { ZaloBotClient } from "./zalo.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ZaloBotClient(config.token);
  const bot = await client.getMe();
  console.log(`Đã kết nối bot "${bot.display_name}" (${bot.account_name}), chế độ ${config.mode}.`);

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log("Đang dừng bot...");
      controller.abort();
      process.exit(0);
    });
  }

  if (config.mode === "webhook") {
    await startWebhook(client, bot, {
      url: config.webhookUrl!,
      secret: config.webhookSecret!,
      port: config.port,
    });
  } else {
    await startPolling(client, bot, controller.signal);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
