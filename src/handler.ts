import { loadApprovers } from "./exchange/approvers.js";
import { RequestStore, respond } from "./exchange/flow.js";
import { SheetSync } from "./exchange/sheet.js";
import { normalize } from "./exchange/text.js";
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

const store = new RequestStore(process.env.DATA_FILE?.trim() || "data/requests.json");
const approvers = loadApprovers();

// Ghi thêm sang Google Sheet nếu đã cài Web App (docs/google-sheet.md).
const sheetUrl = process.env.SHEET_WEBHOOK_URL?.trim();
if (sheetUrl) {
  const sheet = new SheetSync(sheetUrl, process.env.SHEET_WEBHOOK_SECRET?.trim() ?? "");
  store.onChange((item) => sheet.push(item));
}

const ids = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Nhóm nhận yêu cầu đổi vé; để trống thì nhận ở mọi nhóm (bản test). */
const requestGroups = ids(process.env.REQUEST_GROUP_IDS);
/** Nhóm nhận báo cáo kết quả đổi vé. */
const reportGroup = process.env.REPORT_GROUP_ID?.trim() || undefined;

/** Trả lời các lệnh không thuộc luồng đổi vé, hoặc từ chối nếu nhắn sai nhóm. */
function routeByGroup(content: string, chatId: string): string | undefined {
  const n = normalize(content);
  if (/^id( nhom)?$/.test(n)) return `ID nhóm này: ${chatId}`;
  if (/^\/?ping\b/.test(n)) return undefined;
  if (chatId === reportGroup) {
    return /^xem\s+yc\d+/.test(n) ? undefined : "Nhóm này chỉ nhận báo cáo đổi vé. Yêu cầu đổi vé vui lòng gửi ở nhóm đổi vé.";
  }
  if (requestGroups.length > 0 && !requestGroups.includes(chatId)) {
    return "Bot chỉ nhận yêu cầu đổi vé ở nhóm đổi vé.";
  }
  return undefined;
}

export async function handleUpdate(client: ZaloBotClient, bot: BotInfo, update: ZaloUpdate): Promise<void> {
  if (process.env.DEBUG_UPDATES === "1") console.log("[update]", JSON.stringify(update));
  const message = update.message;
  if (!message?.text || message.from?.is_bot) return;
  if (update.event_name && update.event_name !== "message.text.received") return;

  const content = stripMention(message.text, [bot.display_name, bot.account_name]);
  const sender = { id: message.from.id, name: message.from.display_name || "anh/chị" };
  const chatId = message.chat.id;
  console.log(`[tin nhắn] ${message.chat.chat_type ?? "?"} ${chatId} | ${sender.name} (${sender.id}): ${message.text}`);

  await client.sendChatAction(chatId).catch(() => undefined);
  const reports: string[] = [];
  const reply = routeByGroup(content, chatId) ?? respond(content, sender, { store, approvers, chatId, reports });
  await client.sendMessage(chatId, reply);

  for (const report of reports) {
    if (!reportGroup) {
      console.log("[báo cáo] chưa cấu hình REPORT_GROUP_ID, bỏ qua:\n" + report);
      continue;
    }
    await client.sendMessage(reportGroup, report).catch((err) => console.error("Lỗi gửi báo cáo:", err));
  }
}
