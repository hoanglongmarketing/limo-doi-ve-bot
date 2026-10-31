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
