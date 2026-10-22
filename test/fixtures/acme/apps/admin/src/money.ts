export function formatCurrency(amount: number, currency: string = "USD"): string {
  const formatter = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (Number.isNaN(amount)) {
    return formatter.format(0);
  }
  return formatter.format(amount);
}
