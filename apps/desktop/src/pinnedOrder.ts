import { readOrder, writeOrder } from "./listOrder";
export {
  itemOrderKey as pinnedOrderKey,
  orderItems as orderPinnedSessions,
  moveItemOrder as movePinnedOrder,
} from "./listOrder";
const storageKey = "latte-work.pinned-order.v1";
export const readPinnedOrder = () => readOrder(storageKey);
export const writePinnedOrder = (order: string[]) =>
  writeOrder(storageKey, order);
