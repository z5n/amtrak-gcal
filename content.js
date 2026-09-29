const BUTTON_CLASS = "gcal-add-event-btn";
const LOG_PREFIX = "[gcal-ext]";

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(LOG_PREFIX, ...args);
}

function startScanner() {
  log("content script loaded", { href: location.href });

  const scheduleScan = debounce(() => {
    try {
      scanForTravelCards();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(LOG_PREFIX, "scan error", e);
    }
  }, 250);

  scheduleScan();
  const obs = new MutationObserver(() => scheduleScan());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => scheduleScan(), 2000);
}

function scanForTravelCards() {
  const cards = findCandidateCards();
  if (cards.length) log("found cards", cards.length);

  cards.forEach(card => {
    if (card.querySelector("." + BUTTON_CLASS)) return;

    const summaryRow =
      card.querySelector(".AmH9I .a8DSAf") ||
      card.querySelector(".t0") ||
      card.querySelector(".t1")?.parentElement ||
      card;

    summaryRow.appendChild(
      createAddButton(() => handleAddToCalendar(card))
    );
  });

  // Emails without Gmail smart cards (raw Amtrak receipt only)
  scanForAmtrakReceipts();
}

function createAddButton(onClick, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label || "Add to Calendar";
  btn.className = BUTTON_CLASS;
  btn.setAttribute("aria-label", "Add to Google Calendar");
  Object.assign(btn.style, {
    marginLeft: "12px",
    padding: "4px 8px",
    fontSize: "12px",
    cursor: "pointer",
    borderRadius: "6px",
    border: "1px solid #1a73e8",
    background: "#1a73e8",
    color: "#fff",
    verticalAlign: "middle"
  });
  btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function scanForAmtrakReceipts() {
  // Skip if this thread already has a smart card (button lives there)
  if (document.querySelector("div.mNKakd[data-card-id]")) return;

  const bodies = document.querySelectorAll(".a3s");
  bodies.forEach(body => {
    if (!isAmtrakReceiptBody(body)) return;

    const host = findReceiptButtonHost(body);
    if (!host || host.querySelector("." + BUTTON_CLASS)) return;

    const trips = parseAmtrakReceiptTrips(body);
    if (!trips.length) {
      log("amtrak receipt found but no trips parsed");
      return;
    }

    log("found amtrak receipt trips", trips.length);

    trips.forEach((trip, i) => {
      const label =
        trips.length > 1 ? `Add to Calendar (${i + 1})` : "Add to Calendar";
      host.appendChild(
        createAddButton(() => openGoogleCalendarEvent(trip), label)
      );
    });
  });
}

function isAmtrakReceiptBody(body) {
  const text = body.textContent || "";
  return (
    /Reservation Number/i.test(text) &&
    /Depart\s+\d{1,2}:\d{2}\s*(?:AM|PM)/i.test(text) &&
    (/SALES RECEIPT/i.test(text) || /amtrak/i.test(text))
  );
}

function findReceiptButtonHost(body) {
  const main = body.closest("[role='main']") || document;
  const subject = main.querySelector("h2.hP");
  if (subject?.parentElement) return subject.parentElement;

  return (
    body.querySelector("[class*='ReceiptsBody']") ||
    body.querySelector("[class*='container']") ||
    body
  );
}

function parseAmtrakReceiptTrips(body) {
  const text = normalizeSpaces(body.innerText || body.textContent || "");
  const trips = [];

  // Prefer structured receipt fields over whole-body regex
  const fromToEl = body.querySelector("[class*='ResFromAndTo']");
  const trainInfoEls = Array.from(
    body.querySelectorAll("[class*='ChangeSummaryTrainInfo']")
  );
  const departEls = Array.from(
    body.querySelectorAll("[class*='ChangeSummaryDepart']")
  );

  const fallbackRoute = fromToEl
    ? parseRouteTitle(fromToEl.textContent)
    : null;

  const resEl = body.querySelector("[class*='ResNumber']");
  const reservation =
    (resEl?.textContent || "").replace(/^Reservation Number\s*-\s*/i, "").trim() ||
    (text.match(/Reservation Number\s*-\s*([A-Z0-9]+)/i) || [])[1] ||
    "";

  // Pair each depart line with its train-info sibling when possible
  const segments = [];
  if (departEls.length) {
    departEls.forEach((depEl, i) => {
      const depText = normalizeSpaces(depEl.textContent || "");
      const depMatch = depText.match(
        /Depart\s+(\d{1,2}:\d{2}\s*(?:AM|PM)),\s*(.+)$/i
      );
      if (!depMatch) return;

      const trainEl =
        trainInfoEls[i] ||
        depEl.parentElement?.querySelector("[class*='ChangeSummaryTrainInfo']") ||
        null;
      const route =
        (trainEl && parseTrainInfoRoute(trainEl.textContent)) ||
        fallbackRoute;

      segments.push({
        time: depMatch[1].replace(/\s+/g, " ").trim(),
        date: depMatch[2].replace(/\s+/g, " ").trim(),
        route
      });
    });
  }

  // Fallback: regex on full body if DOM pairing failed
  if (!segments.length) {
    const departRe =
      /Depart\s+(\d{1,2}:\d{2}\s*(?:AM|PM)),\s*([^,\n]+,\s*[A-Za-z]+\s+\d{1,2},\s*20\d{2})/gi;
    let m;
    while ((m = departRe.exec(text)) !== null) {
      segments.push({
        time: m[1].replace(/\s+/g, " ").trim(),
        date: m[2].replace(/\s+/g, " ").trim(),
        route: fallbackRoute
      });
    }
  }

  for (const seg of segments) {
    const start = parseDateTime(`${seg.date}, ${seg.time}`);
    if (!start) continue;

    // Receipts usually omit arrival; default ~3h for regional trips
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);

    const route = seg.route;
    const fromShort = route ? shortCity(route.from) : "";
    const toShort = route ? shortCity(route.to) : "";
    const title =
      fromShort && toShort ? `${fromShort} to ${toShort}` : "Amtrak trip";

    const whenLine = formatSmartWhenLine(start, end);
    const depTimeLabel = formatClock(start);
    const arrTimeLabel = formatClock(end);

    const details = [
      whenLine ? `When: ${whenLine}` : null,
      fromShort
        ? `Departs: ${fromShort} • Departs at ${depTimeLabel}`
        : null,
      toShort ? `Arrives: ${toShort} • Arrives at ${arrTimeLabel}` : null,
      reservation ? `Reservation number: ${reservation}` : null
    ]
      .filter(Boolean)
      .join("\n");

    trips.push({
      title,
      start,
      end,
      location: fromShort && toShort ? `${fromShort} → ${toShort}` : "",
      details,
      whenLine
    });
  }

  return trips;
}

/** "153: Newark, NJ - Penn Station to Washington, DC - Union Station (One-Way)" */
function parseTrainInfoRoute(raw) {
  const cleaned = normalizeSpaces(raw || "");
  const m = cleaned.match(
    /(?:TRAIN\s+)?(\d+)\s*:\s*(.+?)\s+to\s+(.+)$/i
  );
  if (!m) return parseRouteTitle(cleaned);
  return {
    train: m[1],
    from: cleanStation(m[2]),
    to: cleanStation(m[3]),
    index: -1
  };
}

function parseRouteTitle(raw) {
  const cleaned = normalizeSpaces(raw || "");
  // "Newark, NJ - Penn Station to Washington, DC - Union Station (One-Way)"
  const m = cleaned.match(/^(.+?)\s+to\s+(.+)$/i);
  if (!m) return null;
  return {
    train: null,
    from: cleanStation(m[1]),
    to: cleanStation(m[2]),
    index: -1
  };
}

function cleanStation(s) {
  return normalizeSpaces(s)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*-\s*/g, " - ")
    .trim();
}

/** "Newark, NJ - Penn Station" → "Newark NJ" (smart-card style) */
function shortCity(station) {
  if (!station) return "";
  const m = station.match(/^([^,]+),\s*([A-Z]{2})\b/i);
  if (m) return `${m[1].trim()} ${m[2].toUpperCase()}`;
  return station.split(" - ")[0].replace(/,/g, "").trim();
}

function formatClock(date) {
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function formatSmartWhenLine(start, end) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const day = `${days[start.getDay()]}, ${months[start.getMonth()]} ${start.getDate()}`;
  return `${day} • ${formatClock(start)} - ${formatClock(end)}`;
}

function normalizeSpaces(s) {
  return String(s)
    .replace(/\u202f/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findCandidateCards() {
  const cards = new Set();

  document
    .querySelectorAll("div.mNKakd[data-card-id]")
    .forEach(el => cards.add(el));

  const departureLabels = Array.from(document.querySelectorAll(".vL")).filter(
    el => el.textContent && el.textContent.trim() === "Departure time"
  );
  for (const label of departureLabels) {
    const card =
      label.closest(".qQ") ||
      label.closest(".yK") ||
      label.closest("[role='button']") ||
      label.closest("div");
    if (card) cards.add(card);
  }

  if (cards.size === 0) {
    document
      .querySelectorAll(".nH.qY .qQ.yK, .qQ.yK, .qQ")
      .forEach(el => cards.add(el));
  }

  return Array.from(cards);
}

/** Gmail nests card header (.mNKakd) and details in sibling blocks under .DC5CAd */
function getCardRoot(card) {
  return card.closest(".DC5CAd") || card;
}

function isHotelCard(card) {
  const root = getCardRoot(card);
  const labels = root.querySelectorAll(".vfbmuc");
  for (const el of labels) {
    const text = el.textContent?.trim() || "";
    if (/check-?in/i.test(text) || /check-?out/i.test(text)) return true;
  }
  return false;
}

function handleAddToCalendar(card) {
  const title = extractTitle(card);
  const inferredYear = inferYearFromEmailContext(card);
  const details = extractDetails(card);

  let start;
  let end;
  let location;

  if (isHotelCard(card)) {
    const stay = extractHotelStay(card, inferredYear);
    if (!stay) {
      log("hotel parse failed", { title });
      alert("Could not parse check-in/check-out from this hotel card.");
      return;
    }
    start = stay.start;
    end = stay.end;
    location = stay.location;
  } else {
    const smartWhen = extractSmartCardWhen(card);

    const departureText =
      smartWhen?.startText || getFieldValue(card, "Departure time") || "";
    const arrivalText =
      smartWhen?.endText || getFieldValue(card, "Arrival time") || "";

    start = parseDateTime(departureText, inferredYear);
    end = parseDateTime(arrivalText, inferredYear);

    if (!start || !end) {
      log("parse failed", { departureText, arrivalText, title });
      alert("Could not parse start/end times from this card.");
      return;
    }

    // Same-date header with a later arrival clock (e.g. 9:25 PM → 12:26 AM),
    // or Dec 31 → Jan 1 parsed with the departure year.
    if (end.getTime() <= start.getTime()) {
      end = rollEndAfterStart(start, end);
    }

    const titleCities = parseTitleCities(title);
    const depCity =
      extractSmartCardDepartsCity(card) ||
      getFieldValue(card, "Departs") ||
      titleCities?.from;
    const arrCity =
      extractSmartCardArrivesCity(card) ||
      getFieldValue(card, "Arrives") ||
      titleCities?.to;
    location = [depCity, arrCity].filter(Boolean).join(" → ");
  }

  openGoogleCalendarEvent({ title, start, end, location, details });
}

function extractHotelStay(card, inferredYear) {
  const root = getCardRoot(card);

  const checkInBlock = root.querySelector(".Yh56qf");
  const checkOutBlock = root.querySelector(".AR2uPc");

  const checkInDate =
    checkInBlock?.querySelector(".HKlhdd")?.textContent?.trim() || "";
  const checkOutDate =
    checkOutBlock?.querySelector(".HKlhdd")?.textContent?.trim() || "";

  const checkInLabel =
    checkInBlock?.querySelector(".vfbmuc")?.textContent?.trim() || "";
  const checkOutLabel =
    checkOutBlock?.querySelector(".vfbmuc")?.textContent?.trim() || "";

  const checkInTime = extractTimeFromLabel(checkInLabel);
  const checkOutTime = extractTimeFromLabel(checkOutLabel);

  // Fallback: date range in header "Fri, Jan 22 - Sun, Jan 24"
  const dateRange = extractSmartCardDateRange(card);
  const startDate = checkInDate || dateRange?.startDate || "";
  const endDate = checkOutDate || dateRange?.endDate || "";

  if (!startDate || !endDate) return null;

  const start = parseDateTime(
    checkInTime ? `${startDate}, ${checkInTime}` : startDate,
    inferredYear
  );
  const end = parseDateTime(
    checkOutTime ? `${endDate}, ${checkOutTime}` : endDate,
    inferredYear
  );

  if (!start || !end) return null;

  return {
    start,
    end,
    location: extractHotelAddress(card)
  };
}

function extractTimeFromLabel(label) {
  if (!label) return null;
  const normalized = label.replace(/\u202f/g, " ").replace(/\u00a0/g, " ");
  const m = normalized.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function extractSmartCardDateRange(card) {
  const line = card.querySelector(".s7IPpf");
  const raw = line?.textContent?.trim();
  if (!raw) return null;

  const normalized = raw.replace(/\u202f/g, " ").replace(/\u00a0/g, " ");
  // "Fri, Jan 22 - Sun, Jan 24" (hotel) — not the train "•" format
  if (normalized.includes("•")) return null;

  const m = normalized.match(
    /^(.+?)\s*-\s*(.+)$/
  );
  if (!m) return null;

  return {
    startDate: m[1].trim(),
    endDate: m[2].trim()
  };
}

function extractHotelAddress(card) {
  const root = getCardRoot(card);

  const ariaEl = root.querySelector("[aria-label^='Address']");
  if (ariaEl) {
    const label = ariaEl.getAttribute("aria-label") || "";
    const addr = label.replace(/^Address,\s*/i, "").trim();
    if (addr) return addr;
  }

  const addressRows = root.querySelectorAll(".oRwJhe");
  for (const row of addressRows) {
    if (row.textContent?.trim() === "Address") {
      const value = row.parentElement?.querySelector(".OIzUn");
      if (value?.textContent?.trim()) return value.textContent.trim();
    }
  }

  return null;
}

function extractAriaField(card, prefix) {
  const root = getCardRoot(card);
  const el = root.querySelector(`[aria-label^='${prefix}']`);
  if (!el) return null;
  const label = el.getAttribute("aria-label") || "";
  const value = label.replace(new RegExp(`^${prefix},\\s*`, "i"), "").trim();
  return value || null;
}

function extractTitle(card) {
  const smartTitle = card.querySelector(".b4qJse");
  if (smartTitle?.textContent?.trim()) {
    return smartTitle.textContent.trim();
  }

  const t1 = card.querySelector(".t1");
  if (t1?.textContent?.trim()) return t1.textContent.trim();

  const t2 = card.querySelector(".t2");
  return (t2?.textContent?.trim()) || "Trip";
}

function extractDetails(card) {
  if (isHotelCard(card)) {
    return extractHotelDetails(card);
  }
  return extractTravelDetails(card);
}

function extractHotelDetails(card) {
  const root = getCardRoot(card);
  const lines = [];

  const whenLine = card.querySelector(".s7IPpf");
  if (whenLine?.textContent?.trim()) {
    lines.push(`Stay: ${whenLine.textContent.trim()}`);
  }

  const checkIn = root.querySelector(".Yh56qf .vfbmuc")?.textContent?.trim();
  const checkInDate = root.querySelector(".Yh56qf .HKlhdd")?.textContent?.trim();
  if (checkIn || checkInDate) {
    lines.push(`Check-in: ${[checkInDate, checkIn].filter(Boolean).join(" • ")}`);
  }

  const checkOut = root.querySelector(".AR2uPc .vfbmuc")?.textContent?.trim();
  const checkOutDate = root.querySelector(".AR2uPc .HKlhdd")?.textContent?.trim();
  if (checkOut || checkOutDate) {
    lines.push(`Check-out: ${[checkOutDate, checkOut].filter(Boolean).join(" • ")}`);
  }

  const address = extractHotelAddress(card);
  if (address) lines.push(`Address: ${address}`);

  const conf = extractAriaField(card, "Confirmation number");
  if (conf) lines.push(`Confirmation number: ${conf}`);

  const phone = extractAriaField(card, "Phone");
  if (phone) lines.push(`Phone: ${phone}`);

  return lines.join("\n");
}

function parseTitleCities(title) {
  const cleaned = normalizeSpaces(title || "");
  const m = cleaned.match(/^(.+?)\s+to\s+(.+)$/i);
  if (!m) return null;
  return { from: m[1].trim(), to: m[2].trim() };
}

function extractWhenLineText(card) {
  const root = getCardRoot(card);
  const el = card.querySelector(".s7IPpf") || root.querySelector(".s7IPpf");
  return el?.textContent?.trim() || "";
}

function clocksFromWhenLine(raw) {
  if (!raw) return { depClock: null, arrClock: null };
  const times = Array.from(String(raw).matchAll(/(\d{1,2}:\d{2}\s*(?:AM|PM))/gi)).map(
    m => m[0]
  );
  return {
    depClock: times[0] || null,
    arrClock: times[1] || null
  };
}

function extractReservationNumber(card) {
  const fromCard = extractAriaField(card, "Reservation number");
  if (fromCard) return fromCard;

  const scopes = [
    card.closest(".eJPjde"),
    card.closest("[role='main']"),
    document.querySelector("[role='main']")
  ].filter(Boolean);

  for (const root of scopes) {
    const el = root.querySelector("[aria-label^='Reservation number']");
    if (!el) continue;
    const label = el.getAttribute("aria-label") || "";
    const value = label.replace(/^Reservation number,\s*/i, "").trim();
    if (value) return value;
  }

  const main =
    card.closest("[role='main']") ||
    document.querySelector("[role='main']") ||
    document.body;
  const bodyText = main.querySelector?.(".a3s")?.textContent || main.textContent || "";
  const m = bodyText.match(/Reservation Number\s*[-:]?\s*([A-Z0-9]+)/i);
  return m ? m[1] : null;
}

function extractTravelDetails(card) {
  const whenRaw = extractWhenLineText(card);
  const titleCities = parseTitleCities(extractTitle(card));
  const clocks = clocksFromWhenLine(whenRaw);

  const depCity = extractSmartCardDepartsCity(card) || titleCities?.from || null;
  const arrCity = extractSmartCardArrivesCity(card) || titleCities?.to || null;

  const depTime =
    extractSmartCardDepartsTime(card) ||
    (clocks.depClock ? `Departs at ${clocks.depClock}` : null);
  const arrTime =
    extractSmartCardArrivesTime(card) ||
    (clocks.arrClock ? `Arrives at ${clocks.arrClock}` : null);

  const resNum = extractReservationNumber(card);

  const smartLines = [];
  if (whenRaw) {
    smartLines.push(`When: ${whenRaw}`);
  }
  if (depCity || depTime) {
    smartLines.push(`Departs: ${[depCity, depTime].filter(Boolean).join(" • ")}`);
  }
  if (arrCity || arrTime) {
    smartLines.push(`Arrives: ${[arrCity, arrTime].filter(Boolean).join(" • ")}`);
  }
  if (resNum) smartLines.push(`Reservation number: ${resNum}`);

  if (smartLines.length) return smartLines.join("\n");

  const fields = [
    "Departure time",
    "Arrival time",
    "Duration",
    "Departs",
    "Arrives",
    "Confirmation number",
    "Passenger",
    "Class"
  ];

  const lines = [];
  fields.forEach(label => {
    const value = getFieldValue(card, label);
    if (value) lines.push(`${label}: ${value}`);
  });

  return lines.join("\n");
}

function getFieldValue(card, labelText) {
  const root = getCardRoot(card);
  const labels = Array.from(root.querySelectorAll(".vL"));
  for (const label of labels) {
    if (label.textContent.trim() === labelText) {
      const valueEl = label.parentElement.querySelector(".vU");
      if (valueEl) return valueEl.textContent.trim();
    }
  }
  return null;
}

function parseDateTime(text, defaultYear) {
  if (!text) return null;
  const cleaned = text
    .replace(/\u202f/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();

  if (/\d{4}/.test(cleaned)) {
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  const year =
    typeof defaultYear === "number" && defaultYear >= 1970 && defaultYear <= 2100
      ? defaultYear
      : new Date().getFullYear();

  const d = new Date(`${cleaned}, ${year}`);
  return isNaN(d.getTime()) ? null : d;
}

function inferYearFromEmailContext(card) {
  const root =
    card.closest("[role='main']") ||
    card.closest(".nH") ||
    document.querySelector("[role='main']") ||
    document.body;

  const subject = root.querySelector("h2.hP")?.textContent || "";
  const yFromSubject = extractYear(subject);
  if (yFromSubject) return yFromSubject;

  const bodyText = root.querySelector(".a3s")?.textContent || "";
  const yFromBody = extractYear(bodyText);
  if (yFromBody) return yFromBody;

  return null;
}

function extractYear(text) {
  if (!text) return null;

  // Prefer trip-style dates: "December 20, 2026" or "12/20/2026"
  const monthDayYear = text.match(
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*(20\d{2})/i
  );
  if (monthDayYear) return Number(monthDayYear[1]);

  const slash = text.match(/\b\d{1,2}\/\d{1,2}\/(20\d{2})\b/);
  if (slash) return Number(slash[1]);

  const m = text.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function formatForGCal(date) {
  const pad = n => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function openGoogleCalendarEvent({ title, start, end, location, details }) {
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", title);
  url.searchParams.set("dates", `${formatForGCal(start)}/${formatForGCal(end)}`);
  if (location) url.searchParams.set("location", location);
  if (details) url.searchParams.set("details", details);

  window.open(url.toString(), "_blank", "noopener");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startScanner);
} else {
  startScanner();
}

function debounce(fn, waitMs) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), waitMs);
  };
}

function extractSmartCardWhen(card) {
  const root = getCardRoot(card);
  const line = card.querySelector(".s7IPpf") || root.querySelector(".s7IPpf");
  const raw = line?.textContent?.trim();
  const fromHeader = raw ? parseSmartWhenLine(raw) : null;
  if (fromHeader) return fromHeader;

  return extractSmartCardWhenFromExpanded(card);
}

/**
 * Same-day: "Sat, Dec 26 • 5:55 AM - 9:01 AM"
 * Overnight / multi-day: "Sun, Dec 27 • 9:25 PM - Mon, Dec 28 • 12:26 AM"
 */
function parseSmartWhenLine(raw) {
  const normalized = normalizeSpaces(raw);
  if (!normalized.includes("•")) return null;

  const overnight = normalized.match(
    /^(.+?)\s*•\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(.+?)\s*•\s*(\d{1,2}:\d{2}\s*(?:AM|PM))$/i
  );
  if (overnight) {
    return {
      startText: `${overnight[1]}, ${overnight[2]}`,
      endText: `${overnight[3]}, ${overnight[4]}`
    };
  }

  const sameDay = normalized.match(
    /^(.+?)\s*•\s*(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM))$/i
  );
  if (!sameDay) return null;

  return {
    startText: `${sameDay[1]}, ${sameDay[2]}`,
    endText: `${sameDay[1]}, ${sameDay[3]}`
  };
}

/** Expanded card: "Departs at 9:25 PM" / "Arrives at 12:26 AM" plus dates from the when line. */
function extractSmartCardWhenFromExpanded(card) {
  const root = getCardRoot(card);
  const line = (card.querySelector(".s7IPpf") || root.querySelector(".s7IPpf"))
    ?.textContent;
  const depTime = extractTimeFromLabel(extractSmartCardDepartsTime(card) || "");
  const arrTime = extractTimeFromLabel(extractSmartCardArrivesTime(card) || "");
  if (!line || !depTime || !arrTime) return null;

  const dates = Array.from(
    normalizeSpaces(line).matchAll(/[A-Za-z]{3},\s+[A-Za-z]{3}\s+\d{1,2}/g)
  ).map(m => m[0]);
  if (!dates.length) return null;

  return {
    startText: `${dates[0]}, ${depTime}`,
    endText: `${dates[1] || dates[0]}, ${arrTime}`
  };
}

function rollEndAfterStart(start, end) {
  const rolled = new Date(end.getTime());
  const crossesNewYear =
    start.getMonth() === 11 && rolled.getMonth() === 0;
  if (crossesNewYear) {
    rolled.setFullYear(start.getFullYear() + 1);
    return rolled;
  }
  return new Date(end.getTime() + 24 * 60 * 60 * 1000);
}

function extractSmartCardDepartsCity(card) {
  const root = getCardRoot(card);
  const cities = root.querySelectorAll(".ZZQPvb .vfbmuc");
  const first = cities?.[0]?.textContent?.trim() || "";
  if (/check-?in/i.test(first)) return null;
  return first || null;
}

function extractSmartCardArrivesCity(card) {
  const root = getCardRoot(card);
  const cities = root.querySelectorAll(".ZZQPvb .vfbmuc");
  const second = cities?.[1]?.textContent?.trim() || "";
  if (/check-?out/i.test(second)) return null;
  return second || null;
}

function extractSmartCardDepartsTime(card) {
  const root = getCardRoot(card);
  return root.querySelector(".ZZQPvb .HKlhdd")?.textContent?.trim() || null;
}

function extractSmartCardArrivesTime(card) {
  const root = getCardRoot(card);
  const els = root.querySelectorAll(".ZZQPvb .HKlhdd");
  return els?.[1]?.textContent?.trim() || null;
}
