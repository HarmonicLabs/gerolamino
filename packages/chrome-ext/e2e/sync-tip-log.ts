/** Parse offscreen session log lines for chain tip slot. */
export const extractTipSlot = (line: string): bigint | undefined => {
  const patterns = [
    /\[offscreen-sync\] tip=(\d+)/i,
    /First tip observed: slot (\d+)/i,
    /blocks, tip slot (\d+)/i,
    /Block processing failed \(era \d+, tip (\d+)\)/i,
    /tip slot (\d+)/i,
    /tip=(\d+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(line);
    if (m) return BigInt(m[1]!);
  }
  return undefined;
};

export const highestTipSlotFromLogs = (logs: ReadonlyArray<string>): bigint => {
  let highest = 0n;
  for (const line of logs) {
    const slot = extractTipSlot(line);
    if (slot !== undefined && slot > highest) highest = slot;
  }
  return highest;
};

export const relaySyncErrorLines = (logs: ReadonlyArray<string>): Array<string> =>
  logs.filter(
    (l) =>
      /\[offscreen-sync\] Error:/i.test(l) ||
      /Handshake refused/i.test(l) ||
      /Block processing failed/i.test(l) ||
      /LSM .* failed/i.test(l),
  );
