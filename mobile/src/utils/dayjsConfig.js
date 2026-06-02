// Global dayjs configuration — imported once, first thing, from index.js so it
// runs before any week math anywhere in the app.
//
// Makes Monday the first day of the week for every `startOf("week")` /
// `endOf("week")` / `week()` computation. NOTE: `.day(n)` is unaffected — it is
// pure Sunday-based arithmetic (0 = Sunday) — so week-start-sensitive code must
// not anchor through it; see utils/recurrence.js, which uses `.day(0)` to pin
// the Sunday explicitly and stays correct regardless of this setting.
import dayjs from "dayjs";
import updateLocale from "dayjs/plugin/updateLocale";

dayjs.extend(updateLocale);
dayjs.updateLocale("en", { weekStart: 1 });
