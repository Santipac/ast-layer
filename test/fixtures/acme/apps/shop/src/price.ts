export function formatPrice(amount: number, currency: string = "USD"): string {
  const fmt = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (Number.isNaN(amount)) {
    return fmt.format(0);
  }
  return fmt.format(amount);
}
