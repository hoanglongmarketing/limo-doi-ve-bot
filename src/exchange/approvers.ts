import type { ExchangeRequest } from "./template.js";
import { normalize } from "./text.js";

export interface Approver {
  name: string;
  /** Zalo user id; để trống thì tạm nhận theo tên hiển thị (chỉ dùng cho bản test). */
  zaloIds: string[];
  displayNames: string[];
}

/** Quy định: vé đi từ Hải Phòng do Ms Ngọc Anh duyệt, đi từ Hà Nội do Mr Thanh Việt duyệt. */
export function loadApprovers(env: NodeJS.ProcessEnv = process.env): Record<ExchangeRequest["origin"], Approver> {
  const ids = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    HAI_PHONG: { name: "Ms Ngọc Anh", zaloIds: ids(env.APPROVER_HAI_PHONG_IDS), displayNames: ["ngoc anh"] },
    HA_NOI: { name: "Mr Thanh Việt", zaloIds: ids(env.APPROVER_HA_NOI_IDS), displayNames: ["thanh viet"] },
  };
}

export function isApprover(approver: Approver, userId: string, displayName?: string): boolean {
  if (approver.zaloIds.length > 0) return approver.zaloIds.includes(userId);
  const name = normalize(displayName ?? "");
  return approver.displayNames.some((n) => name.includes(n));
}
