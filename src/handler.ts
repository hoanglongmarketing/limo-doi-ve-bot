import { loadApprovers } from "./exchange/approvers.js";
import { RequestStore, respond } from "./exchange/flow.js";
import type { BotInfo, ZaloBotClient, ZaloUpdate } from "./zalo.js";

/** Bỏ mọi "@Tên bot" trong tin (Zalo có thể đặt @nhắc ở đầu hoặc cuối) để lấy nội dung thật. */
export function stripMention(text: string, botNames: string[]): string {
  let result = text;
  for (const name of botNames.filter(Boolean)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`@${escaped}`, "gi"), " ");
  }
  return result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .trim()
    .replace(/^[,:\-\s]+/, "")
    .trim();
}

const store = new RequestStore();
const approvers = loadApprovers();

export async function handleUpdate(client: ZaloBotClient, bot: BotInfo, update: ZaloUpdate): Promise<void> {
  if (process.env.DEBUG_UPDATES === "1") console.log("[update]", JSON.stringify(update));
  const message = update.message;
  if (!message?.text || message.from?.is_bot) return;
  if (update.event_name && update.event_name !== "message.text.received") return;

  const content = stripMention(message.text, [bot.display_name, bot.account_name]);
  const sender = { id: message.from.id, name: message.from.display_name || "anh/chị" };
  console.log(
    `[tin nhắn] ${message.chat.chat_type ?? "?"} ${message.chat.id} | ${sender.name} (${sender.id}): ${message.text}`,
  );

  await client.sendChatAction(message.chat.id).catch(() => undefined);
  await client.sendMessage(message.chat.id, respond(content, sender, { store, approvers }));
}
