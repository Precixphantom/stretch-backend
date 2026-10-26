// Same rules as the frontend's lib/roommate-calculations.ts, so both sides agree.

/**
 * Splits an amount equally in whole naira between `memberIds` (given in room order).
 * Leftover naira go one each to the first members, so shares never differ by more
 * than ₦1 and always add up to the full amount. ₦10,000 ÷ 3 → 3,334 + 3,333 + 3,333.
 */
export function splitAmount(amount, memberIds) {
  if (memberIds.length === 0) return [];
  const base = Math.floor(amount / memberIds.length);
  const leftover = amount - base * memberIds.length;
  return memberIds.map((memberId, index) => ({ memberId, amount: base + (index < leftover ? 1 : 0) }));
}

/**
 * Each member's position. `net` > 0: the room owes them. `net` < 0: they owe the room.
 * Shares are the ones stored with each expense. Only confirmed settlements count.
 */
export function calculateBalances(memberIds, expenses, settlements) {
  const balances = new Map(
    memberIds.map((memberId) => [memberId, { memberId, paid: 0, share: 0, sent: 0, received: 0, net: 0 }]),
  );

  for (const expense of expenses) {
    const payer = balances.get(expense.paidBy);
    if (payer) payer.paid += expense.amount;
    for (const share of expense.shares) {
      const balance = balances.get(share.memberId);
      if (balance) balance.share += share.amount;
    }
  }

  for (const settlement of settlements) {
    if (settlement.status !== 'confirmed') continue;
    const debtor = balances.get(settlement.from);
    const creditor = balances.get(settlement.to);
    if (debtor) debtor.sent += settlement.amount;
    if (creditor) creditor.received += settlement.amount;
  }

  for (const balance of balances.values()) {
    balance.net = balance.paid - balance.share + balance.sent - balance.received;
  }
  return [...balances.values()];
}

/** The fewest simple "X pays Y" transfers that bring every balance to zero. */
export function suggestTransfers(balances) {
  const creditors = balances
    .filter((balance) => balance.net > 0)
    .map((balance) => ({ id: balance.memberId, amount: balance.net }))
    .sort((a, b) => b.amount - a.amount);
  const debtors = balances
    .filter((balance) => balance.net < 0)
    .map((balance) => ({ id: balance.memberId, amount: -balance.net }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = Math.min(creditors[c].amount, debtors[d].amount);
    transfers.push({ from: debtors[d].id, to: creditors[c].id, amount });
    creditors[c].amount -= amount;
    debtors[d].amount -= amount;
    if (creditors[c].amount === 0) c += 1;
    if (debtors[d].amount === 0) d += 1;
  }
  return transfers;
}
