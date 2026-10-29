/** Chữ thường, bỏ dấu tiếng Việt, gộp khoảng trắng: "Hải Phòng" -> "hai phong". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
