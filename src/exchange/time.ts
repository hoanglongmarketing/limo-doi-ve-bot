import { fold } from "./text.js";

// Giờ Việt Nam (UTC+7, không đổi giờ mùa hè).
const VN_OFFSET_HOURS = 7;
const DAY_MS = 24 * 3600_000;

/**
 * Chuyến mới được phép đã chạy tối đa bấy nhiêu phút, vì xe mất tối đa 40 phút từ văn phòng
 * tới điểm đón. Vd 10h10 vẫn đổi được sang chuyến 9h30.
 */
export const NEW_TRIP_GRACE_MINUTES = 40;
export const NEW_TRIP_GRACE_MS = NEW_TRIP_GRACE_MINUTES * 60_000;

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
  /** Ghi chú khi tin ghi ngày mâu thuẫn, vd "ngày mai 29/10" nhưng 29/10 là hôm nay. */
  warning?: string;
}

const RELATIVE_DAYS: [RegExp, number, string][] = [
  [/\bngay kia\b/, 2, "ngày kia"],
  [/\b(ngay )?mai\b/, 1, "ngày mai"],
  [/\bhom nay\b/, 0, "hôm nay"],
];

/** Ngày ghi trong tin: đủ ngày/tháng/năm, thiếu năm, hoặc chỉ có ngày. */
interface DateText {
  day: number;
  month?: number;
  year?: number;
}

/**
 * Tìm ngày trong tin: "30/10/2026", "30-10", "30.10.26", "30 tháng 10", "30 thg 10 năm 2026",
 * "ngày 30", "ng 30". Trả về chuỗi khớp (theo vị trí trong `text`) và các phần đọc được.
 */
export function findDateText(text: string): { text: string; date: DateText } | undefined {
  const folded = fold(text);
  const at = (m: RegExpMatchArray, date: DateText) => ({ text: text.slice(m.index!, m.index! + m[0].length), date });
  const num = /(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?(?!\d)/.exec(folded);
  if (num) return at(num, { day: +num[1], month: +num[2], year: num[3] ? +num[3] : undefined });
  const words = /\b(\d{1,2})\s*(?:thang|thg|th)\s*(\d{1,2})(?:\s*(?:nam|,)?\s*(\d{4}))?\b/.exec(folded);
  if (words) return at(words, { day: +words[1], month: +words[2], year: words[3] ? +words[3] : undefined });
  const dayOnly = /\b(?:ngay|ng|hom)\s*(\d{1,2})(?!\d|\s*(?::|h|g))/.exec(folded);
  if (dayOnly) return at(dayOnly, { day: +dayOnly[1] });
  return undefined;
}

function validDay(year: number, month: number, day: number): boolean {
  return day >= 1 && month >= 1 && month <= 12 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Đọc giờ ngày kiểu "08:00 30/10/2026", "30/10 8h30", "16h45", "8h ngày 30", "8h 30 tháng 10".
 * Thiếu năm thì lấy năm gần hôm nay nhất (cuối tháng 12 ghi 02/01 là năm sau).
 * Chỉ có ngày thì lấy tháng gần nhất; với chuyến mới (`futureOnly`) ngày đã qua thì sang tháng sau.
 * Không ghi ngày thì lấy `baseDate` nếu có, không thì hôm nay, hoặc ngày mai
 * nếu `futureOnly` và giờ đó hôm nay đã qua quá NEW_TRIP_GRACE_MINUTES phút.
 */
export function parseVnDateTime(
  text: string,
  now: Date = new Date(),
  opts: { futureOnly?: boolean; baseDate?: Date } = {},
): ParsedDateTime | undefined {
  const found = findDateText(text);
  // Bỏ phần ngày trước khi tìm giờ, để "ngày 15 7h" không bị đọc giờ nhầm.
  const timeText = found ? text.replace(found.text, " ") : text;
  const time = timeText.match(/(\d{1,2})\s*(?::|h|g)(\d{2})?/i);
  if (!time) return undefined;
  const hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (hour > 23 || minute > 59) return undefined;

  const today = vnParts(now);
  const folded = fold(text);
  const relative = RELATIVE_DAYS.find(([re]) => re.test(folded));
  const todayAt = vnDate(today.year, today.month, today.day, hour, minute);
  const todayStart = vnDate(today.year, today.month, today.day, 0, 0).getTime();

  if (!found && relative) {
    return { date: new Date(todayAt.getTime() + relative[1] * DAY_MS), dateAssumed: false };
  }
  if (!found) {
    if (opts.baseDate) {
      const b = vnParts(opts.baseDate);
      return { date: vnDate(b.year, b.month, b.day, hour, minute), dateAssumed: true };
    }
    let result = todayAt;
    if (opts.futureOnly && result.getTime() < now.getTime() - NEW_TRIP_GRACE_MS) result = new Date(result.getTime() + DAY_MS);
    return { date: result, dateAssumed: true };
  }

  const { day } = found.date;
  let result: Date | undefined;
  if (found.date.month === undefined) {
    // Chỉ có ngày: thử tháng trước, tháng này, tháng sau; lấy tháng gần hôm nay nhất.
    const options: Date[] = [];
    for (const shift of [-1, 0, 1, 2]) {
      const m = today.month - 1 + shift;
      const y = today.year + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12 + 1;
      if (validDay(y, month, day)) options.push(vnDate(y, month, day, hour, minute));
    }
    const pool = opts.futureOnly ? options.filter((d) => d.getTime() >= todayStart) : options;
    result = pool.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0];
  } else {
    const month = found.date.month;
    let year = found.date.year;
    if (year !== undefined && year < 100) year += 2000;
    if (year !== undefined) {
      if (validDay(year, month, day)) result = vnDate(year, month, day, hour, minute);
    } else {
      // Thiếu năm: lấy năm gần hôm nay nhất.
      result = [today.year - 1, today.year, today.year + 1]
        .filter((y) => validDay(y, month, day))
        .map((y) => vnDate(y, month, day, hour, minute))
        .sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0];
    }
  }
  if (!result) return undefined;

  if (relative) {
    const expected = new Date(todayAt.getTime() + relative[1] * DAY_MS);
    if (formatVn(expected).slice(6) !== formatVn(result).slice(6)) {
      return {
        date: result,
        dateAssumed: false,
        warning: `Tin ghi "${relative[2]}" nhưng lại ghi ngày ${formatVn(result).slice(6, 11)}, bot lấy theo ngày ${formatVn(result).slice(6, 11)} (${relative[2]} là ${formatVn(expected).slice(6, 11)})`,
      };
    }
  }
  return { date: result, dateAssumed: false };
}

export function formatVn(d: Date): string {
  const p = vnParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}/${p.year}`;
}
