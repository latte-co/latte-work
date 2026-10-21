import { readOrder, writeOrder } from "./listOrder";
export {
  itemOrderKey as projectOrderKey,
  orderItems as orderProjects,
  moveItemKeys as moveProjectKeys,
  moveItemOrder as moveProjectOrder,
} from "./listOrder";
const storageKey = "latte-work.project-order.v1";
export const readProjectOrder = () => readOrder(storageKey);
export const writeProjectOrder = (order: string[]) =>
  writeOrder(storageKey, order);
