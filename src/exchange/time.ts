// Giờ Việt Nam (UTC+7, không đổi giờ mùa hè).
const VN_OFFSET_HOURS = 7;
const DAY_MS = 24 * 3600_000;

export function vnParts(d: Date) {
  const vn = new Date(d.getTime() + VN_OFFSET_HOURS * 3600_000);
  return {
    year: vn.getUTCFullYear(),
    month: vn.getUTCMonth() + 1,
    day: vn.getUTCDate(),
    hour: vn.getUTCHours(),
    minute: vn.getUTCMinutes(),
  };
}

function vnDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - VN_OFFSET_HOURS, minute));
}

export interface ParsedDateTime {
  date: Date;
  /** true khi tin không ghi ngày và bot tự điền. */
  dateAssumed: boolean;
}

/**
 * Đọc giờ ngày kiểu "08:00 30/10/2026", "30/10 8h30", "16h45".
 * Không ghi năm thì lấy năm nay. Không ghi ngày thì lấy hôm nay, hoặc ngày mai
 * nếu `futureOnly` và giờ đó hôm nay đã qua.
 */
export function parseVnDateTime(
  text: string,
  now: Date = new Date(),
  opts: { futureOnly?: boolean } = {},
): ParsedDateTime | undefined {
  const time = text.match(/(\d{1,2})\s*(?::|h|g)(\d{2})?/i);
  if (!time) return undefined;
  const hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (hour > 23 || minute > 59) return undefined;

  const today = vnParts(now);
  const date = text.match(/(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/);
  if (!date) {
    let result = vnDate(today.year, today.month, today.day, hour, minute);
    if (opts.futureOnly && result.getTime() <= now.getTime()) result = new Date(result.getTime() + DAY_MS);
    return { date: result, dateAssumed: true };
  }

  const day = Number(date[1]);
  const month = Number(date[2]);
  let year = date[3] ? Number(date[3]) : today.year;
  if (year < 100) year += 2000;
  if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  return { date: vnDate(year, month, day, hour, minute), dateAssumed: false };
}

export function formatVn(d: Date): string {
  const p = vnParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}/${p.year}`;
}
