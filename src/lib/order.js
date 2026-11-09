// Pure helpers for reordering services while hidden services keep their slots.

// Moves `id` inside `list` so it ends up at `toIndex` (index in the list without `id`).
export const moveTo = (list, id, toIndex) => {
  const without = list.filter((item) => item !== id);
  if (without.length === list.length) return list.slice();
  const index = Math.max(0, Math.min(without.length, toIndex));
  return [...without.slice(0, index), id, ...without.slice(index)];
};

// Writes a new visible order back into the full order. Hidden ids stay at their positions;
// visible slots are refilled in the new visible order.
export const mergeVisibleOrder = (allIds, nextVisibleIds) => {
  const visible = new Set(nextVisibleIds);
  const queue = nextVisibleIds.filter((id) => allIds.includes(id));
  const merged = allIds.map((id) => (visible.has(id) ? queue.shift() : id));
  return queue.length ? [...merged, ...queue] : merged;
};

// Swaps `id` with its nearest visible neighbour in `direction` (-1 up, +1 down).
// Returns null when the move is impossible.
export const moveAmongVisible = (allIds, visibleIds, id, direction) => {
  const index = visibleIds.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= visibleIds.length) return null;
  const nextVisible = visibleIds.slice();
  [nextVisible[index], nextVisible[target]] = [nextVisible[target], nextVisible[index]];
  return mergeVisibleOrder(allIds, nextVisible);
};

// Drag-and-drop: places `draggedId` before/after `overId` among the visible ids.
// Returns null when nothing would change.
export const dropAmongVisible = (allIds, visibleIds, draggedId, overId, position) => {
  if (!visibleIds.includes(draggedId) || !visibleIds.includes(overId) || draggedId === overId) {
    return null;
  }
  const without = visibleIds.filter((id) => id !== draggedId);
  const overIndex = without.indexOf(overId);
  const nextVisible = moveTo(visibleIds, draggedId, position === "after" ? overIndex + 1 : overIndex);
  if (nextVisible.every((id, index) => id === visibleIds[index])) return null;
  return mergeVisibleOrder(allIds, nextVisible);
};

export const sameOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
