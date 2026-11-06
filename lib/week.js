export function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export function getPreviousWeekStart() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return getWeekStart(d);
}
