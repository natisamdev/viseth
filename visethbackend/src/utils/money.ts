export function roundEtb(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function ticketAmount(price: number, guests: number): number {
  return roundEtb(price * guests);
}

export function feeAmount(amount: number, feePercent: number): number {
  return roundEtb((amount * feePercent) / 100);
}

export function commissionAmount(amount: number, rate: number): number {
  return roundEtb((amount * rate) / 100);
}
