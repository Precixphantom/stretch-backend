// All money values here are in kobo.
function calculateSummary(row) {
  // The pg library returns BIGINT/SUM values as strings, so convert them
  const startingBalance = Number(row.starting_balance_kobo);
  const totalSpent = Number(row.total_spent);
  const totalExtra = Number(row.total_extra);
  const spentToday = Number(row.spent_today);
  const daysLeft = Number(row.days_left);
  const daysElapsed = Math.max(1, Number(row.days_elapsed));

  // Facts in, answer out: the balance is never stored, always calculated
  const balance = startingBalance + totalExtra - totalSpent;

  const allowanceDue = daysLeft <= 0;

  // Safe to Spend Today = (balance now + what you already spent today) / days left
  // Adding spentToday back means the daily limit stays fixed while you spend
  // through the day, then drops tomorrow if you overspent.
  let safeToday = 0;
  if (!allowanceDue) {
    safeToday = Math.max(0, Math.floor((balance + spentToday) / daysLeft));
  }
  const remainingToday = safeToday - spentToday; // negative means over the limit

  // Preview of tomorrow, assuming no more spending today
  const tomorrowIfNoMoreSpending =
    daysLeft > 1 ? Math.max(0, Math.floor(balance / (daysLeft - 1))) : 0;

  // Survival Mode: will the money run out before the next allowance
  // at the average daily spending rate so far?
  let survival = { active: false };
  if (!allowanceDue && totalSpent > 0) {
    const avgDaily = totalSpent / daysElapsed;
    const daysMoneyLasts = balance > 0 ? Math.floor(balance / avgDaily) : 0;
    if (daysMoneyLasts < daysLeft) {
      survival = {
        active: true,
        avgDailySpendKobo: Math.round(avgDaily),
        daysMoneyLasts,
        daysLeft,
        suggestedDailyLimitKobo: Math.max(0, Math.floor(balance / daysLeft))
      };
    }
  }

  return {
    balanceKobo: balance,
    daysLeft,
    allowanceDue,
    safeToSpendTodayKobo: safeToday,
    spentTodayKobo: spentToday,
    remainingTodayKobo: remainingToday,
    tomorrowIfNoMoreSpendingKobo: tomorrowIfNoMoreSpending,
    survivalMode: survival
  };
}

module.exports = { calculateSummary };