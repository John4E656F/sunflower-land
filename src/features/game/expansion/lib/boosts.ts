import Decimal from "decimal.js-light";

import { Bumpkin, GrubShopOrder, Inventory } from "../../types/game";
import { SellableItem } from "features/game/events/landExpansion/sellCrop";
import { CROPS } from "../../types/crops";
import { CAKES } from "../../types/craftables";
import { Consumable } from "features/game/types/consumables";

const crops = CROPS();
const cakes = CAKES();

/**
 * How much SFL an item is worth
 */
export const getSellPrice = (
  item: SellableItem,
  inventory: Inventory,
  bumpkin: Bumpkin
) => {
  let price = item.sellPrice;

  if (!price) {
    return new Decimal(0);
  }

  // apply Green Thumb boost to crop LEGACY SKILL!
  if (item.name in crops && inventory["Green Thumb"]?.greaterThanOrEqualTo(1)) {
    price = price.mul(1.05);
  }

  // apply Chef Apron 20% boost when selling cakes
  if (
    item.name in cakes &&
    bumpkin.equipped.coat &&
    bumpkin.equipped.coat === "Chef Apron"
  ) {
    price = price.mul(1.2);
  }

  return price;
};

/**
 * To be used as boolean flag
 * Update if more upcoming boosts
 */
export const hasSellBoost = (inventory: Inventory) => {
  if (inventory["Green Thumb"]?.greaterThanOrEqualTo(1)) {
    return true;
  }

  return false;
};

/**
 * Get reduced cooking time from bumpkin skills.
 * @param seconds time to be decreased
 * @param bumpkin to check for skills
 * @returns reduced cooking
 */
export const getCookingTime = (
  seconds: number,
  bumpkin: Bumpkin | undefined
): number => {
  let reducedSecs = new Decimal(seconds);

  // 10% reduction
  if (bumpkin?.skills["Rush Hour"]) {
    reducedSecs = reducedSecs.mul(0.9);
  }

  return reducedSecs.toNumber();
};

/**
 * Get boosted exp from Bumpkin skills.
 * Decimal mul for precision.
 * @todo add "Curer" skill once "Fermented Goods" are finalized
 * @param foodExp value to be increased
 * @param bumpkin to check for skills
 * @returns boosted food exp
 */
export const getFoodExpBoost = (food: Consumable, bumpkin: Bumpkin): number => {
  let boostedExp = new Decimal(food.experience);
  const { skills, equipped } = bumpkin;
  const { tool } = equipped;

  //Bumpkin Skill Boost Kitchen Hand
  if (skills["Kitchen Hand"]) {
    boostedExp = boostedExp.mul(1.05);
  }
  //Bumpkin Skill Boost Curer
  if (food.building === "Deli" && skills["Curer"]) {
    boostedExp = boostedExp.mul(1.15);
  }

  //Bumpkin Wearable Boost Golden Spatula
  if (tool === "Golden Spatula") {
    boostedExp = boostedExp.mul(1.1);
  }

  return boostedExp.toNumber();
};

export const getOrderSellPrice = (bumpkin: Bumpkin, order: GrubShopOrder) => {
  const { skills } = bumpkin;
  let mul = 1;

  if (skills["Michelin Stars"]) {
    mul += 0.05;
  }

  if (order.name in CAKES() && bumpkin.equipped.coat === "Chef Apron") {
    mul += 0.2;
  }

  return order.sfl.mul(mul);
};
