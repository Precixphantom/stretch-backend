import { config } from '../config.js';

// en-CA formats dates as YYYY-MM-DD.
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar date in the app's time zone, as `YYYY-MM-DD`. */
export function todayISO() {
  return formatter.format(new Date());
}
