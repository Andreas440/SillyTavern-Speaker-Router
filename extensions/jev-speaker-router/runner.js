/** Bounded, sequential routing. All environment effects live in the adapter. */
export async function runTurns(adapter, {limit = 3, dryRun = false, signal} = {}) {
    const stopped = () => signal?.aborted;
    const maximum = Math.max(1, Math.min(10, Number(limit) || 3));
    let count = 0;
    while (count < maximum) {
        if (stopped()) return {reason:'stopped',count};
        const snapshot = await adapter.capture(count);
        if (stopped()) return {reason:'stopped',count};
        const decision = await adapter.decide(snapshot, signal);
        if (stopped()) return {reason:'stopped',count};
        if (!adapter.isCurrent(snapshot)) return {reason:'changed',count};
        adapter.display(snapshot, decision, dryRun);
        if (dryRun) return {reason:'dry-run',count};
        if (decision.selected === 'USER') return {reason:'user',count};
        await adapter.generate(snapshot, decision.selected);
        count++;
        if (stopped()) return {reason:'stopped',count};
    }
    return {reason:'limit',count};
}
