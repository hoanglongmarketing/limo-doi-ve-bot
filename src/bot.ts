import { loadApprovers } from "./exchange/approvers.js";
import { loadHoangLongApi } from "./hl/api.js";
import { respond } from "./exchange/flow.js";
import { SheetSync } from "./exchange/sheet.js";
import type { RequestStore } from "./exchange/store.js";
import { normalize } from "./exchange/text.js";
import type { BotInfo, ZaloBotClient, ZaloUpdate } from "./zalo.js";

/** Biến cấu hình, đọc từ .env (Node) hoặc Variables/Secrets (Cloudflare). */
export type BotEnv = Record<string, string | undefined>;

/** Dấu cách đặc biệt Zalo có thể chèn khi gõ nhiều dấu cách (non-breaking, zero-width...). */
const ODD_SPACES = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u2060\u3000\ufeff]/g;

/**
 * Bỏ mọi "@Tên bot" trong tin (Zalo có thể đặt @nhắc ở đầu hoặc cuối) để lấy nội dung thật.
 * Gõ bao nhiêu dấu cách giữa tên bot và tin cũng được.
 */
export function stripMention(text: string, botNames: string[]): string {
  let result = text.normalize("NFC").replace(ODD_SPACES, " ");
  for (const name of botNames.filter(Boolean)) {
    const pattern = name
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    result = result.replace(new RegExp(`@\\s*${pattern}`, "giu"), " ");
  }
  return result
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim()
    .replace(/^[,:\-\s]+/, "")
    .trim();
}

/** Dữ liệu webhook có thể là update hoặc { result: update }. */
export function unwrapUpdate(payload: unknown): ZaloUpdate {
  const p = payload as { result?: ZaloUpdate } & ZaloUpdate;
  return p.result ?? p;
}

export interface Bot {
  handleUpdate(update: ZaloUpdate): Promise<void>;
  /** Chờ các lần ghi Google Sheet còn đang chạy. */
  flush(): Promise<void>;
}

export function createBot(client: ZaloBotClient, info: BotInfo, store: RequestStore, env: BotEnv): Bot {
  const approvers = loadApprovers(env);
  const api = loadHoangLongApi(env);
  const ids = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  /** Nhóm nhận yêu cầu đổi vé; để trống thì nhận ở mọi nhóm (bản test). */
  const requestGroups = ids(env.REQUEST_GROUP_IDS);
  /** Nhóm nhận báo cáo kết quả đổi vé. */
  const reportGroup = env.REPORT_GROUP_ID?.trim() || undefined;

  // Ghi thêm sang Google Sheet nếu đã cài Web App (docs/google-sheet.md).
  const sheetUrl = env.SHEET_WEBHOOK_URL?.trim();
  const sheet = sheetUrl ? new SheetSync(sheetUrl, env.SHEET_WEBHOOK_SECRET?.trim() ?? "") : undefined;
  if (sheet) store.onChange((item) => sheet.push(item));

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

  async function handleUpdate(update: ZaloUpdate): Promise<void> {
    if (env.DEBUG_UPDATES === "1") console.log("[update]", JSON.stringify(update));
    const message = update.message;
    if (!message?.text || message.from?.is_bot) return;
    if (update.event_name && update.event_name !== "message.text.received") return;

    const content = stripMention(message.text, [info.display_name, info.account_name]);
    const sender = { id: message.from.id, name: message.from.display_name || "anh/chị" };
    const chatId = message.chat.id;
    console.log(`[tin nhắn] ${message.chat.chat_type ?? "?"} ${chatId} | ${sender.name} (${sender.id}): ${message.text}`);

    await client.sendChatAction(chatId).catch(() => undefined);
    const reports: string[] = [];
    const notices: { chatId: string; text: string }[] = [];
    let reply: string;
    try {
      reply = routeByGroup(content, chatId) ?? (await respond(content, sender, { store, approvers, chatId, reports, api, notices }));
    } catch (err) {
      // Lỗi bất ngờ vẫn trả lời, để người gửi không phải chờ.
      console.error("Lỗi xử lý tin:", err);
      reply = `Bot gặp lỗi khi xử lý tin này: ${err instanceof Error ? err.message : String(err)}. Anh/chị thử gửi lại sau ít phút.`;
    }
    await client.sendMessage(chatId, reply);

    // Nhắn riêng người duyệt (có thể Zalo chỉ cho gửi khi người duyệt đã từng nhắn riêng với bot).
    for (const notice of notices) {
      await client.sendMessage(notice.chatId, notice.text).catch((err) => console.error(`Lỗi nhắn riêng ${notice.chatId}:`, err));
    }

    for (const report of reports) {
      if (!reportGroup) {
        console.log("[báo cáo] chưa cấu hình REPORT_GROUP_ID, bỏ qua:\n" + report);
        continue;
      }
      await client.sendMessage(reportGroup, report).catch((err) => console.error("Lỗi gửi báo cáo:", err));
    }
  }

  return { handleUpdate, flush: () => sheet?.flush() ?? Promise.resolve() };
}
