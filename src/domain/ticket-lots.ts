type Entry = {
  paymentId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  units: number;
};

// Reservations and refund holds are negative entries in the same purchase lot.
// Keep the ledger's expiry rule (strictly later than now), including restoration.
export function availableTicketLots(entries: Entry[], now = new Date()) {
  const lots = new Map<
    string,
    { id: string; purchasedAt: Date; expiresAt: Date | null; units: number }
  >();
  for (const entry of entries) {
    if (entry.expiresAt && entry.expiresAt <= now) continue;
    const id =
      entry.paymentId ?? `grant:${entry.expiresAt?.toISOString() ?? "none"}`;
    const lot = lots.get(id) ?? {
      id,
      purchasedAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      units: 0,
    };
    lot.units += entry.units;
    if (entry.createdAt < lot.purchasedAt) lot.purchasedAt = entry.createdAt;
    lots.set(id, lot);
  }
  return [...lots.values()]
    .filter((lot) => lot.units > 0)
    .sort(
      (a, b) =>
        (a.expiresAt?.getTime() ?? Infinity) -
        (b.expiresAt?.getTime() ?? Infinity),
    );
}
