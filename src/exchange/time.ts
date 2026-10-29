// Giờ Việt Nam (UTC+7, không đổi giờ mùa hè).
const VN_OFFSET_HOURS = 7;

/**
 * Đọc ngày giờ kiểu "08:00 30/10/2026", "30/10 8h30", "8h 30/10/2026".
 * Không ghi năm thì lấy năm hiện tại. Trả về undefined nếu không đọc được.
 */
export function parseVnDateTime(text: string, now: Date = new Date()): Date | undefined {
  const time = text.match(/(\d{1,2})\s*(?::|h|g)(\d{2})?/i);
  const date = text.match(/(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/);
  if (!time || !date) return undefined;

  const hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  const day = Number(date[1]);
  const month = Number(date[2]);
  let year = date[3] ? Number(date[3]) : vnParts(now).year;
  if (year < 100) year += 2000;
  if (hour > 23 || minute > 59 || day < 1 || day > 31 || month < 1 || month > 12) return undefined;

  return new Date(Date.UTC(year, month - 1, day, hour - VN_OFFSET_HOURS, minute));
}

function vnParts(d: Date) {
  const vn = new Date(d.getTime() + VN_OFFSET_HOURS * 3600_000);
  return {
    year: vn.getUTCFullYear(),
    month: vn.getUTCMonth() + 1,
    day: vn.getUTCDate(),
    hour: vn.getUTCHours(),
    minute: vn.getUTCMinutes(),
  };
}

export function formatVn(d: Date): string {
  const p = vnParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}/${p.year}`;
}
