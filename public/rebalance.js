export function planRebalance({ wallets, strategy = "equal", floor = 0, buffer = 0, minimum = 1, fee = 1_000 }) {
  const working = wallets.map((entry) => ({ ...entry, balance:Math.max(0, Math.floor(Number(entry.balance) || 0)) }));
  const original = new Map(working.map((entry) => [entry.address, entry.balance]));
  const total = working.reduce((sum, entry) => sum + entry.balance, 0);
  const moves = [];
  floor = Math.max(0, Math.floor(Number(floor) || 0));
  buffer = Math.max(0, Math.floor(Number(buffer) || 0));
  minimum = Math.max(1, Math.floor(Number(minimum) || 1));
  fee = Math.max(0, Math.floor(Number(fee) || 0));
  if (working.length >= 2 && total > 0) {
    const target = strategy === "equal" ? Math.floor(total / working.length) : floor;
    const receivers = working.filter((entry) => entry.balance + minimum < target);
    const donorFloor = strategy === "equal" ? Math.max(buffer, target) : Math.max(buffer, floor);
    const donors = working.filter((entry) => entry.balance > donorFloor + fee + minimum);
    let guard = 0;
    while (receivers.length && donors.length && guard++ < 100) {
      receivers.sort((a, b) => (target - b.balance) - (target - a.balance));
      donors.sort((a, b) => b.balance - a.balance);
      const receiver = receivers[0];
      const donor = donors[0];
      const amount = Math.floor(Math.min(target - receiver.balance, donor.balance - donorFloor - fee));
      if (amount < minimum) break;
      moves.push({ from:donor.address, fromName:donor.name, to:receiver.address, toName:receiver.name, amount, fee });
      donor.balance -= amount + fee;
      receiver.balance += amount;
      if (target - receiver.balance < minimum) receivers.shift();
      if (donor.balance - donorFloor - fee < minimum) donors.shift();
    }
  }
  const afterTotal = working.reduce((sum, entry) => sum + entry.balance, 0);
  return {
    wallets:working,
    moves,
    total,
    volume:moves.reduce((sum, move) => sum + move.amount, 0),
    fees:moves.reduce((sum, move) => sum + move.fee, 0),
    beforeLargest:total ? Math.max(...working.map((entry) => original.get(entry.address) || 0)) / total : 0,
    afterLargest:afterTotal ? Math.max(...working.map((entry) => entry.balance)) / afterTotal : 0,
    belowFloor:strategy === "floor" ? working.filter((entry) => entry.balance < floor).length : 0,
  };
}
