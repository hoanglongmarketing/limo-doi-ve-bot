/** Chữ thường, bỏ dấu tiếng Việt, gộp khoảng trắng: "Hải Phòng" -> "hai phong". */
export function normalize(text: string): string {
  return fold(text).replace(/\s+/g, " ").trim();
}

/** Bỏ dấu và viết thường nhưng giữ nguyên độ dài, để vị trí khớp được với chuỗi gốc (dạng NFC). */
export function fold(text: string): string {
  return Array.from(text.normalize("NFC"), (c) =>
    c.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().slice(0, c.length) || c,
  ).join("");
}

/**
 * Tin có từ khóa đổi vé không: "đổi", "dời", "chuyển", "sửa", "lùi" (vd đổi vé, chuyển vé, sửa vé,
 * dời chuyến, lùi chuyến). "chuyển" xét theo chữ có dấu để không nhầm "chuyến";
 * gõ không dấu thì nhận "chuyen ve".
 */
export function hasExchangeKeyword(text: string): boolean {
  const lower = text.normalize("NFC").toLowerCase();
  if (/(?<!\p{L})chuyển(?!\p{L})/u.test(lower)) return true;
  const f = fold(text);
  return /\b(doi|sua|lui)\b/.test(f) || /\bchuyen ve\b/.test(f);
}

/** Dòng tiêu đề của mẫu: "ĐỔI VÉ", "CHUYỂN VÉ", "SỬA VÉ", "DỜI CHUYẾN", "YÊU CẦU ĐỔI VÉ"... */
export function isExchangeHeading(line: string): boolean {
  return /^(yeu cau )?(doi|chuyen|sua|lui) (ve|chuyen)$/.test(normalize(line));
}
