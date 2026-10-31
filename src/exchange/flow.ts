import { isApprover, type Approver } from "./approvers.js";
import { looksLikeFreeText, readFreeText } from "./freetext.js";
import {
  buildRequest,
  looksLikeTemplate,
  parseExchangeRequest,
  REQUEST_TEMPLATE,
  renderForm,
  type ExchangeRequest,
} from "./template.js";
import { normalize } from "./text.js";
import type { RequestStatus, RequestStore, StoredRequest } from "./store.js";
import { formatVn } from "./time.js";
import { ORIGIN_LABEL, type Origin } from "./trip.js";

export { RequestStore } from "./store.js";

export interface Sender {
  id: string;
  name: string;
}

export interface FlowContext {
  store: RequestStore;
  approvers: Record<Origin, Approver>;
  now?: Date;
  /** Nhóm đang nhắn, lưu kèm yêu cầu. */
  chatId?: string;
  /** Bot đẩy báo cáo (đã duyệt / từ chối) vào đây để gửi sang nhóm báo cáo. */
  reports?: string[];
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  NHAP: "chờ người gửi xác nhận",
  CHO_DUYET: "chờ duyệt",
  DA_DUYET: "đã duyệt",
  TU_CHOI: "từ chối",
};

export function helpText(senderName: string): string {
  return [
    `Chào ${senderName}! Em là bot đổi vé LIMO Hoàng Long (bản test).`,
    "• Gửi yêu cầu: @bot rồi nhắn bình thường, vd: A711655 A714050 đổi chuyến 16h45 HĐ-HP sang chuyến 18h HN-HP (lý do). Bot soạn form, người gửi chỉ cần @bot Xác nhận.",
    "• Hoặc gửi theo mẫu: @bot mẫu",
    "• Người duyệt: @bot Đồng ý YC001 hoặc @bot Từ chối YC001 <lý do>",
    "• Xem trạng thái: @bot xem YC001",
  ].join("\n");
}

function ticketsLabel(r: ExchangeRequest): string {
  return r.ticketCodes.length === 1 ? `vé ${r.ticketCodes[0]}` : `${r.ticketCodes.length} vé ${r.ticketCodes.join(", ")}`;
}

function checksText(item: StoredRequest): string[] {
  return [
    item.overdue
      ? "⚠️ Vé QUÁ HẠN (chuyến cũ đã chạy). Chỉ đổi được khi có xác nhận đồng ý."
      : "✅ Chuyến cũ chưa chạy.",
    "⏳ Ghế trống và chênh lệch giá/phụ thu: chưa kiểm tra (chờ API Hoàng Long).",
  ];
}

function waitingApprovalText(item: StoredRequest, approver: Approver): string {
  return `Chờ ${approver.name} duyệt. Trả lời: @bot Đồng ý ${item.id} hoặc @bot Từ chối ${item.id}`;
}

function draftReply(item: StoredRequest): string {
  const r = item.request;
  return [
    `Em đã soạn yêu cầu ${item.id} (${ticketsLabel(r)}):`,
    "",
    renderForm(r),
    "",
    ...r.assumptions.map((a) => `ℹ️ ${a}`),
    ...checksText(item),
    "",
    `${item.requestedBy.name} kiểm tra giúp em: đúng thì @bot Xác nhận, sai thì sao chép form trên, sửa rồi gửi lại.`,
  ].join("\n");
}

function submittedReply(item: StoredRequest, approver: Approver): string {
  return [
    `Đã nhận yêu cầu ${item.id} từ ${item.requestedBy.name}:`,
    "",
    renderForm(item.request),
    "",
    ...item.request.assumptions.map((a) => `ℹ️ ${a}`),
    ...checksText(item),
    "",
    waitingApprovalText(item, approver),
  ].join("\n");
}

function handleConfirm(content: string, sender: Sender, ctx: FlowContext): string | undefined {
  const m = normalize(content).match(/^xac nhan\b\s*(yc\d+)?/);
  if (!m) return undefined;
  const item = m[1] ? ctx.store.get(m[1]) : ctx.store.latestDraftBy(sender.id);
  if (!item) return m[1] ? `Không tìm thấy yêu cầu ${m[1].toUpperCase()}.` : "Không có yêu cầu nào đang chờ anh/chị xác nhận.";
  if (item.status !== "NHAP") return `${item.id} đã được xác nhận trước đó (${STATUS_LABEL[item.status]}).`;
  if (item.requestedBy.id !== sender.id) return `Chỉ ${item.requestedBy.name} (người gửi) xác nhận được ${item.id}.`;

  item.status = "CHO_DUYET";
  ctx.store.save(item);
  return `Đã xác nhận ${item.id} (${ticketsLabel(item.request)}).\n${waitingApprovalText(item, ctx.approvers[item.request.origin])}`;
}

function handleDecision(content: string, sender: Sender, ctx: FlowContext): string | undefined {
  const m = normalize(content).match(/^(dong y|duyet|ok|tu choi|khong dong y)\s+(yc\d+)\b/);
  if (!m) return undefined;
  const approve = m[1] === "dong y" || m[1] === "duyet" || m[1] === "ok";
  const item = ctx.store.get(m[2]);
  if (!item) return `Không tìm thấy yêu cầu ${m[2].toUpperCase()}.`;

  const approver = ctx.approvers[item.request.origin];
  if (!isApprover(approver, sender.id, sender.name)) {
    return `${item.id} là vé đi từ ${ORIGIN_LABEL[item.request.origin]}, chỉ ${approver.name} được duyệt.`;
  }
  if (item.status === "NHAP") {
    return `${item.id} chưa được ${item.requestedBy.name} xác nhận. Người gửi @bot Xác nhận trước ạ.`;
  }
  if (item.status !== "CHO_DUYET") {
    return `${item.id} đã được xử lý trước đó (${STATUS_LABEL[item.status]} bởi ${item.decidedBy}).`;
  }

  item.status = approve ? "DA_DUYET" : "TU_CHOI";
  item.decidedBy = sender.name;
  item.decidedAt = ctx.now ?? new Date();
  // Lấy lý do ở nội dung gốc để giữ dấu.
  const note = content.replace(/^\s*\S+(\s+\S+)?\s+yc\d+\s*/i, "").trim();
  if (note) item.decisionNote = note;
  ctx.store.save(item);
  ctx.reports?.push(reportText(item));

  if (!approve) {
    return `❌ ${approver.name} đã từ chối ${item.id} (${ticketsLabel(item.request)}).${note ? `\nLý do: ${note}` : ""}`;
  }
  return [
    `✅ ${approver.name} đã đồng ý đổi ${item.id} (${ticketsLabel(item.request)}).`,
    "Bản test: bot CHƯA đổi vé thật trên hệ thống. Khi có API Hoàng Long, bước này sẽ kiểm tra ghế, tính phụ thu và đổi vé.",
  ].join("\n");
}

/** Báo cáo gửi sang nhóm báo cáo khi yêu cầu có kết quả. */
export function reportText(item: StoredRequest): string {
  const approved = item.status === "DA_DUYET";
  return [
    `${approved ? "✅ ĐÃ DUYỆT" : "❌ TỪ CHỐI"} ĐỔI VÉ ${item.id}`,
    "",
    renderForm(item.request),
    "",
    `Người gửi: ${item.requestedBy.name} lúc ${formatVn(item.requestedAt)}`,
    `${approved ? "Người duyệt" : "Người từ chối"}: ${item.decidedBy}${item.decidedAt ? ` lúc ${formatVn(item.decidedAt)}` : ""}`,
    item.decisionNote ? `Ghi chú: ${item.decisionNote}` : undefined,
    item.overdue ? "⚠️ Vé quá hạn" : undefined,
    approved ? "Trạng thái đổi vé trên hệ thống: chưa thực hiện (bản test)" : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function missingInfoReply(errors: string[]): string {
  return ["Yêu cầu đổi vé chưa đủ thông tin:", ...errors.map((e) => `• ${e}`), "", 'Gõ "@bot mẫu" để lấy mẫu.'].join("\n");
}

/** Xử lý nội dung (đã bỏ @bot) và trả về câu trả lời. */
export function respond(content: string, sender: Sender, ctx: FlowContext): string {
  const now = ctx.now ?? new Date();
  const n = normalize(content);

  if (n === "" || /^(help|\/help|huong dan)\b/.test(n)) return helpText(sender.name);
  if (/^\/?ping\b/.test(n)) return "pong 🏓";
  if (/^\/?mau( doi ve)?$/.test(n)) {
    return `Mẫu yêu cầu đổi vé (sao chép, điền rồi gửi kèm @bot):\n\n${REQUEST_TEMPLATE}`;
  }

  const view = n.match(/^xem\s+(yc\d+)\b/);
  if (view) {
    const item = ctx.store.get(view[1]);
    if (!item) return `Không tìm thấy yêu cầu ${view[1].toUpperCase()}.`;
    const by = item.decidedBy ? ` bởi ${item.decidedBy}` : "";
    return `${item.id}: ${STATUS_LABEL[item.status]}${by}\n\n${renderForm(item.request)}`;
  }

  const confirm = handleConfirm(content, sender, ctx);
  if (confirm) return confirm;
  const decision = handleDecision(content, sender, ctx);
  if (decision) return decision;

  // Mẫu điền đủ: người gửi đã tự kiểm tra, chuyển thẳng cho người duyệt.
  if (looksLikeTemplate(content)) {
    const parsed = parseExchangeRequest(content, now);
    if (!parsed.ok) return missingInfoReply(parsed.errors);
    const item = addRequest(ctx, parsed.request, sender, now, "CHO_DUYET");
    return submittedReply(item, ctx.approvers[parsed.request.origin]);
  }

  // Tin viết tự do: bot soạn form, người gửi xác nhận.
  if (looksLikeFreeText(content)) {
    const parsed = buildRequest(readFreeText(content), now);
    if (!parsed.ok) return missingInfoReply(parsed.errors);
    return draftReply(addRequest(ctx, parsed.request, sender, now, "NHAP"));
  }

  return `Em chưa hiểu yêu cầu. Gõ "@bot help" để xem hướng dẫn.`;
}

function addRequest(
  ctx: FlowContext,
  request: ExchangeRequest,
  sender: Sender,
  now: Date,
  status: RequestStatus,
): StoredRequest {
  return ctx.store.add({
    request,
    requestedBy: sender,
    requestedAt: now,
    chatId: ctx.chatId,
    overdue: request.oldDeparture.getTime() <= now.getTime(),
    status,
  });
}
