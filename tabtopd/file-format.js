const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

export function sortEntries(entries, sort) {
    const dirSign = (e) => (e.dir ? 0 : 1);
    const value = { name: () => 0, size: (e) => e.bytes ?? 0, time: (e) => e.time ?? 0 }[sort.key];
    return [...entries].sort((a, b) => {
        let c = value(a) - value(b);
        if (sort.key === "name" || c === 0) {
            c = byName(a.name, b.name);
        }
        return dirSign(a) - dirSign(b) || (sort.desc ? -c : c);
    });
}

// Each formatter owns its timezone and clock, independently of other views.
export function createTimeFormatter({ timeZone: initialZone = "UTC", locale, now = () => new Date() } = {}) {
    // The time zone the page shows times in: the server's TZ, from its
    // listings, UTC until then, or if this browser doesn't know the zone.
    let timeZone;

    // clocks are the formats for times in timeZone, made again when it
    // changes.
    let clocks = null;

    function setTimeZone(tz = "UTC") {
        try {
            new Intl.DateTimeFormat(locale, { timeZone: tz });
        } catch {
            tz = "UTC";  // a zone this browser doesn't know
        }
        if (clocks && tz === timeZone) {
            return;
        }
        timeZone = tz;
        const f = (options) => new Intl.DateTimeFormat(locale, { timeZone, ...options });
        clocks = {
            relativeDay: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
            clock: f({ hour: "numeric", minute: "2-digit" }),
            weekday: f({ weekday: "short" }),
            dayMonth: f({ day: "numeric", month: "short" }),
            withYear: f({ dateStyle: "medium" }),
            exact: f({ weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
                second: "2-digit", timeZoneName: "short" }),
            short: f({ dateStyle: "short", timeStyle: "medium" }),
            ymd: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "numeric", day: "numeric" }),
        };
    }

    // dayNumber counts days to when's date in timeZone, to tell how many days
    // apart two times are there.
    function dayNumber(when) {
        const part = Object.fromEntries(clocks.ymd.formatToParts(when).map((p) => [p.type, Number(p.value)]));
        return Date.UTC(part.year, part.month - 1, part.day) / 86400000;
    }

    // friendlyTime is a time in Unix seconds as people say it, in the
    // browser's language and the page's time zone: today's and yesterday's
    // with the time, the rest of the past week's by the day and time, this
    // year's by the date, and older ones with the year. exactTime is the whole
    // of it, shown on hover.
    function friendlyTime(seconds) {
        const when = new Date(seconds * 1000);
        const today = new Date(now());
        const days = dayNumber(today) - dayNumber(when);
        if (days === 0 || days === 1) {
            const name = clocks.relativeDay.format(-days, "day");  // "today", "yesterday"
            return `${name[0].toUpperCase()}${name.slice(1)} ${clocks.clock.format(when)}`;
        }
        if (days > 1 && days < 7) {
            return `${clocks.weekday.format(when)} ${clocks.clock.format(when)}`;
        }
        const year = (d) => clocks.ymd.formatToParts(d).find((p) => p.type === "year").value;
        return year(when) === year(today) ? clocks.dayMonth.format(when) : clocks.withYear.format(when);
    }

    function exactTime(seconds) {
        return clocks.exact.format(seconds * 1000);
    }


    function shortTime(value) { return clocks.short.format(new Date(value)); }

    setTimeZone(initialZone);
    return { setTimeZone, friendlyTime, exactTime, shortTime };
}

// humanBytes is a size as the listing shows it (see humanSize in main.go):
// in units of 1024, so the two agree.
export function humanBytes(n) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    for (; n >= 1024 && i < units.length - 1; i++) {
        n /= 1024;
    }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
}
