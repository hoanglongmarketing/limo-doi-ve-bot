import { isApprover, type Approver } from "./approvers.js";
import { looksLikeExchangeRequest, parseExchangeRequest, REQUEST_TEMPLATE, type ExchangeRequest } from "./template.js";
import { normalize } from "./text.js";
import { formatVn } from "./time.js";

export type RequestStatus = "CHO_DUYET" | "DA_DUYET" | "TU_CHOI";

export interface StoredRequest {
  id: string;
  request: ExchangeRequest;
  requestedBy: { id: string; name: string };
  requestedAt: Date;
  overdue: boolean;
  status: RequestStatus;
  decidedBy?: string;
}

/** Lưu tạm trong bộ nhớ cho bản test; khởi động lại bot là mất. */
export class RequestStore {
  private seq = 0;
  private readonly items = new Map<string, StoredRequest>();

  add(item: Omit<StoredRequest, "id">): StoredRequest {
    const id = `YC${String(++this.seq).padStart(3, "0")}`;
    const stored = { ...item, id };
    this.items.set(id, stored);
    return stored;
  }

  get(id: string): StoredRequest | undefined {
    return this.items.get(id.toUpperCase());
  }
}

export interface Sender {
  id: string;
  name: string;
}

export interface FlowContext {
  store: RequestStore;
  approvers: Record<ExchangeRequest["origin"], Approver>;
  now?: Date;
}

const ORIGIN_LABEL: Record<ExchangeRequest["origin"], string> = {
  HAI_PHONG: "Hải Phòng",
  HA_NOI: "Hà Nội",
};

export function helpText(senderName: string): string {
  return [
    `Chào ${senderName}! Em là bot đổi vé LIMO Hoàng Long (bản test).`,
    "• Gửi yêu cầu: @bot rồi dán mẫu đổi vé đã điền.",
    "• Lấy mẫu trống: @bot mẫu",
    "• Người duyệt trả lời: @bot Đồng ý YC001 hoặc @bot Từ chối YC001 <lý do>",
    "• Xem trạng thái: @bot xem YC001",
  ].join("\n");
}

function summary(item: StoredRequest): string {
  const r = item.request;
  return [
    `Mã vé: ${r.ticketCode}`,
    r.customerName || r.customerPhone ? `Khách: ${[r.customerName, r.customerPhone].filter(Boolean).join(" - ")}` : undefined,
    `Điểm đi: ${ORIGIN_LABEL[r.origin]}`,
    `Chuyến cũ: ${formatVn(r.oldDeparture)}${r.oldSeat ? `, ghế ${r.oldSeat}` : ""}`,
    `Chuyến mới: ${formatVn(r.newDeparture)}${r.newSeat ? `, ghế ${r.newSeat}` : ""}`,
    r.reason ? `Lý do: ${r.reason}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function newRequestReply(item: StoredRequest, approver: Approver): string {
  return [
    `Đã nhận yêu cầu ${item.id} từ ${item.requestedBy.name}:`,
    summary(item),
    "",
    item.overdue
      ? "⚠️ Vé QUÁ HẠN (chuyến cũ đã chạy). Chỉ đổi được khi có xác nhận đồng ý."
      : "✅ Chuyến cũ chưa chạy.",
    "⏳ Ghế trống và chênh lệch giá/phụ thu: chưa kiểm tra (chờ API Hoàng Long).",
    "",
    `Chờ ${approver.name} duyệt. Trả lời: @bot Đồng ý ${item.id} hoặc @bot Từ chối ${item.id}`,
  ].join("\n");
}

function handleDecision(content: string, sender: Sender, ctx: FlowContext): string | undefined {
  const m = normalize(content).match(/^(dong y|duyet|ok|tu choi|khong dong y)\s+(yc\d+)\b\s*(.*)$/);
  if (!m) return undefined;
  const approve = m[1] === "dong y" || m[1] === "duyet" || m[1] === "ok";
  const item = ctx.store.get(m[2]);
  if (!item) return `Không tìm thấy yêu cầu ${m[2].toUpperCase()}.`;

  const approver = ctx.approvers[item.request.origin];
  if (!isApprover(approver, sender.id, sender.name)) {
    return `${item.id} là vé đi từ ${ORIGIN_LABEL[item.request.origin]}, chỉ ${approver.name} được duyệt.`;
  }
  if (item.status !== "CHO_DUYET") {
    return `${item.id} đã được xử lý trước đó (${item.status === "DA_DUYET" ? "đã duyệt" : "từ chối"} bởi ${item.decidedBy}).`;
  }

  item.status = approve ? "DA_DUYET" : "TU_CHOI";
  item.decidedBy = sender.name;
  if (!approve) {
    // Lấy lý do ở nội dung gốc để giữ dấu.
    const reason = content.replace(/^\s*\S+(\s+\S+)?\s+yc\d+\s*/i, "").trim();
    return `❌ ${approver.name} đã từ chối ${item.id} (vé ${item.request.ticketCode}).${reason ? `\nLý do: ${reason}` : ""}`;
  }
  return [
    `✅ ${approver.name} đã đồng ý đổi ${item.id} (vé ${item.request.ticketCode}).`,
    "Bản test: bot CHƯA đổi vé thật trên hệ thống. Khi có API Hoàng Long, bước này sẽ kiểm tra ghế, tính phụ thu và đổi vé.",
  ].join("\n");
}

/** Xử lý nội dung (đã bỏ @bot) và trả về câu trả lời. */
export function respond(content: string, sender: Sender, ctx: FlowContext): string {
  const now = ctx.now ?? new Date();
  const n = normalize(content);

  if (n === "" || n === "help" || n === "/help" || n === "huong dan") return helpText(sender.name);
  if (n === "ping" || n === "/ping") return "pong 🏓";
  if (n === "mau" || n === "mau doi ve" || n === "/mau") {
    return `Mẫu yêu cầu đổi vé (sao chép, điền rồi gửi kèm @bot):\n\n${REQUEST_TEMPLATE}`;
  }

  const view = n.match(/^xem\s+(yc\d+)$/);
  if (view) {
    const item = ctx.store.get(view[1]);
    if (!item) return `Không tìm thấy yêu cầu ${view[1].toUpperCase()}.`;
    const status = { CHO_DUYET: "chờ duyệt", DA_DUYET: `đã duyệt bởi ${item.decidedBy}`, TU_CHOI: `từ chối bởi ${item.decidedBy}` }[item.status];
    return `${item.id}: ${status}\n${summary(item)}`;
  }

  const decision = handleDecision(content, sender, ctx);
  if (decision) return decision;

  if (looksLikeExchangeRequest(content)) {
    const parsed = parseExchangeRequest(content, now);
    if (!parsed.ok) {
      return [
        "Yêu cầu đổi vé chưa đủ thông tin:",
        ...parsed.errors.map((e) => `• ${e}`),
        "",
        "Gõ \"@bot mẫu\" để lấy mẫu.",
      ].join("\n");
    }
    const item = ctx.store.add({
      request: parsed.request,
      requestedBy: sender,
      requestedAt: now,
      overdue: parsed.request.oldDeparture.getTime() <= now.getTime(),
      status: "CHO_DUYET",
    });
    return newRequestReply(item, ctx.approvers[parsed.request.origin]);
  }

  return `Em chưa hiểu yêu cầu. Gõ "@bot mẫu" để lấy mẫu đổi vé, hoặc "@bot help" để xem hướng dẫn.`;
}
