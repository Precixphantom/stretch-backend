import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateBalances, splitAmount, suggestTransfers } from '../src/modules/room/room.calculations.js';

const everyone = ['chidinma', 'tobi', 'halima'];

function expense(amount, paidBy, splitWith = everyone) {
  return { amount, paidBy, shares: splitAmount(amount, splitWith) };
}

// The frontend's demo room: ₦18,000 shared three ways is ₦6,000 each.
const demoExpenses = [expense(6_000, 'chidinma'), expense(9_000, 'tobi'), expense(3_000, 'halima')];

describe('splitAmount', () => {
  it('gives leftover naira to the first members in room order', () => {
    assert.deepEqual(splitAmount(10_000, everyone), [
      { memberId: 'chidinma', amount: 3_334 },
      { memberId: 'tobi', amount: 3_333 },
      { memberId: 'halima', amount: 3_333 },
    ]);
  });

  it('always adds up to the full amount', () => {
    for (const amount of [1, 2, 7, 100, 9_999, 10_000_000]) {
      const total = splitAmount(amount, everyone).reduce((sum, share) => sum + share.amount, 0);
      assert.equal(total, amount);
    }
  });

  it('gives one person the whole amount', () => {
    assert.deepEqual(splitAmount(500, ['tobi']), [{ memberId: 'tobi', amount: 500 }]);
  });
});

describe('balances and transfers', () => {
  it('reproduces the demo: Halima owes Tobi ₦3,000', () => {
    const balances = calculateBalances(everyone, demoExpenses, []);
    assert.deepEqual(
      balances.map((balance) => [balance.memberId, balance.net]),
      [
        ['chidinma', 0],
        ['tobi', 3_000],
        ['halima', -3_000],
      ],
    );
    assert.deepEqual(suggestTransfers(balances), [{ from: 'halima', to: 'tobi', amount: 3_000 }]);
  });

  it('ignores payments still awaiting confirmation', () => {
    const settlements = [{ from: 'halima', to: 'tobi', amount: 3_000, status: 'awaiting-confirmation' }];
    const transfers = suggestTransfers(calculateBalances(everyone, demoExpenses, settlements));
    assert.deepEqual(transfers, [{ from: 'halima', to: 'tobi', amount: 3_000 }]);
  });

  it('settles everyone once the payment is confirmed', () => {
    const settlements = [{ from: 'halima', to: 'tobi', amount: 3_000, status: 'confirmed' }];
    const balances = calculateBalances(everyone, demoExpenses, settlements);
    assert.ok(balances.every((balance) => balance.net === 0));
    assert.deepEqual(suggestTransfers(balances), []);
  });

  it('ignores declined payments', () => {
    const settlements = [{ from: 'halima', to: 'tobi', amount: 3_000, status: 'declined' }];
    const transfers = suggestTransfers(calculateBalances(everyone, demoExpenses, settlements));
    assert.deepEqual(transfers, [{ from: 'halima', to: 'tobi', amount: 3_000 }]);
  });

  it('only charges the members an expense was split between', () => {
    const balances = calculateBalances(everyone, [expense(4_000, 'chidinma', ['chidinma', 'tobi'])], []);
    assert.deepEqual(
      balances.map((balance) => balance.net),
      [2_000, -2_000, 0],
    );
  });
});
