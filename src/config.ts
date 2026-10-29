export type BotMode = "polling" | "webhook";

export interface Config {
  token: string;
  mode: BotMode;
  webhookUrl?: string;
  webhookSecret?: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ZALO_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("Thiếu ZALO_BOT_TOKEN. Sao chép .env.example thành .env và điền token.");
  }

  const mode = (env.BOT_MODE?.trim() || "polling") as BotMode;
  if (mode !== "polling" && mode !== "webhook") {
    throw new Error(`BOT_MODE không hợp lệ: ${mode} (chỉ nhận polling hoặc webhook)`);
  }

  const config: Config = {
    token,
    mode,
    webhookUrl: env.WEBHOOK_URL?.trim() || undefined,
    webhookSecret: env.WEBHOOK_SECRET?.trim() || undefined,
    port: Number(env.PORT) || 3000,
  };

  if (mode === "webhook" && (!config.webhookUrl || !config.webhookSecret)) {
    throw new Error("BOT_MODE=webhook cần WEBHOOK_URL và WEBHOOK_SECRET.");
  }
  return config;
}
