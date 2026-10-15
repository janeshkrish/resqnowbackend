// India Standard Time day boundaries. The business runs in India; servers run in UTC.
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

export const istDayStart = (ms) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
export const istHour = (ms) => new Date(ms + IST_OFFSET_MS).getUTCHours();
export const istWeekday = (ms) => new Date(ms + IST_OFFSET_MS).getUTCDay();
