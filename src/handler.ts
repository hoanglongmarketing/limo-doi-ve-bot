import type { BotInfo, ZaloBotClient, ZaloUpdate } from "./zalo.js";

/** Bỏ phần "@Tên bot" ở đầu tin nhắn (nếu có) để lấy nội dung thật. */
export function stripMention(text: string, botNames: string[]): string {
  let result = text.trim();
  for (const name of botNames.filter(Boolean)) {
    const prefix = `@${name}`;
    if (result.toLowerCase().startsWith(prefix.toLowerCase())) {
      result = result.slice(prefix.length).trim();
      break;
    }
  }
  return result.replace(/^[,:\-\s]+/, "").trim();
}

/** Câu trả lời cho bước 1: xác nhận đã nhận tin. Logic đổi vé sẽ thêm ở bước sau. */
export function buildReply(content: string, senderName: string): string {
  const normalized = content.toLowerCase();
  if (normalized === "" || normalized === "help" || normalized === "/help" || normalized === "hướng dẫn") {
    return [
      `Chào ${senderName}! Em là bot đổi vé LIMO Hoàng Long.`,
      "Hiện em đang ở bản thử nghiệm: em nhận tin và trả lời lại để kiểm tra kết nối.",
      "Gõ \"ping\" để kiểm tra bot còn chạy.",
    ].join("\n");
  }
  if (normalized === "ping" || normalized === "/ping") {
    return "pong 🏓";
  }
  return `Em đã nhận yêu cầu của ${senderName}:\n«${content}»\n(Chức năng đổi vé đang được xây dựng.)`;
}

export async function handleUpdate(client: ZaloBotClient, bot: BotInfo, update: ZaloUpdate): Promise<void> {
  if (process.env.DEBUG_UPDATES === "1") console.log("[update]", JSON.stringify(update));
  const message = update.message;
  if (!message?.text || message.from?.is_bot) return;
  if (update.event_name && update.event_name !== "message.text.received") return;

  const content = stripMention(message.text, [bot.display_name, bot.account_name]);
  const senderName = message.from.display_name || "anh/chị";
  console.log(
    `[tin nhắn] ${message.chat.chat_type ?? "?"} ${message.chat.id} | ${senderName}: ${message.text}`,
  );

  await client.sendChatAction(message.chat.id).catch(() => undefined);
  await client.sendMessage(message.chat.id, buildReply(content, senderName));
}
